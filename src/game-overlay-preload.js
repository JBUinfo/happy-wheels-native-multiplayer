(() => {
  const boot = () => {
  if (document.getElementById("happy-wheels-lan-overlay")) return;

  const { webFrame } = require("electron");

  // Webpack renames its chunk queue on game updates; its push is replaced by the loader.
  function findWebpackQueue() {
    for (const key of Object.keys(window)) {
      let value;
      try { value = window[key]; } catch { continue; }
      if (Array.isArray(value) && typeof value.push === "function" && value.push !== Array.prototype.push) return value;
    }
    return null;
  }

  function installNativeBridge(webpackRequire) {
    const bridgeKey = "__HW_LAN_NATIVE_BRIDGE__";
    const characterExports = {
      1: "Qd", 2: "HK", 3: "jm", 4: "Rf", 5: "eV", 6: "V8",
      7: "AE", 8: "sB", 9: "yP", 10: "Jw", 11: "_0",
    };
    const oldCharacterExports = { 2: "ae", 4: "_w" };
    const pixelScale = 62.5;
    let desiredPeers = [];
    let selfId = null;
    let context = null;
    let lastError = "";
    const failedPeers = new Map();

    function module(id) {
      try { return webpackRequire(id); } catch { return null; }
    }

    function settings() {
      return module(35057)?.w ?? null;
    }

    function currentSession() {
      try { return settings()?.currentSession ?? null; } catch { return null; }
    }

    function sessionIsReady(session) {
      return Boolean(session?.m_world && session?.level && session?._character &&
        Array.isArray(session.level.paintItemVector) && Array.isArray(session.level.actionsVector));
    }

    function listItems(first) {
      const items = [];
      for (let item = first; item && items.length < 10000; item = item.m_next) items.push(item);
      return items;
    }

    function liveBodies(world) {
      try { return listItems(world?.GetBodyList?.()); } catch { return []; }
    }

    function liveJoints(world) {
      try { return listItems(world?.GetJointList?.()); } catch { return []; }
    }

    function physScale(actor) {
      return Number.isFinite(actor?.m_physScale) ? actor.m_physScale : pixelScale;
    }

    // cameraFocus is the body the native camera follows: the chest, or the heart
    // after the chest is destroyed.
    function focusBody(actor) {
      for (const name of ["cameraFocus", "centralBody", "chestBody", "pelvisBody", "head1Body"]) {
        try {
          const body = actor?.[name];
          const point = body?.GetWorldCenter?.();
          if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) return body;
        } catch { /* Getters throw while a character is being torn down. */ }
      }
      return null;
    }

    function actorPosition(actor) {
      const body = focusBody(actor);
      if (!body) return null;
      const point = body.GetWorldCenter();
      return { x: point.x * physScale(actor), y: point.y * physScale(actor) };
    }

    // Same point the session passes to its own character constructor (pixels).
    function startPosition(session) {
      try {
        const point = session.getStartPoint?.() ?? session.level?.startPoint;
        if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) return { x: point.x, y: point.y };
      } catch { /* Fall through to the current actor position. */ }
      return actorPosition(session._character) ?? { x: 0, y: 0 };
    }

    function silenceStats(actor) {
      // Remote deaths and injuries must not count towards the local player's stats.
      for (let proto = Object.getPrototypeOf(actor); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) {
          if (/^track[A-Z]/.test(name) && typeof proto[name] === "function" && !Object.prototype.hasOwnProperty.call(actor, name)) {
            actor[name] = function () {};
          }
        }
      }
    }

    // Records the bodies, joints and sprites created while a remote actor runs,
    // because the native die() only drops references and leaves them in the level.
    function installOwnershipHooks(contextRef) {
      const world = contextRef.session.m_world;
      const container = contextRef.session.containerSprite;
      if (contextRef.hookedWorld === world && contextRef.hookedContainer === container) return;
      removeOwnershipHooks(contextRef);
      const patch = (target, name, record) => {
        if (!target || typeof target[name] !== "function") return;
        const original = target[name];
        const hadOwn = Object.prototype.hasOwnProperty.call(target, name);
        const wrapper = function () {
          const result = original.apply(this, arguments);
          if (contextRef.owner) record(contextRef.owner, result, arguments);
          return result;
        };
        target[name] = wrapper;
        contextRef.ownershipPatches.push({ target, name, original, hadOwn, wrapper });
      };
      patch(world, "CreateBody", (owner, body) => {
        if (!body) return;
        owner.bodies.add(body);
        contextRef.bodyOwners.set(body, owner);
      });
      patch(world, "CreateJoint", (owner, joint) => { if (joint) owner.joints.add(joint); });
      patch(container, "addChild", (owner, result, args) => { for (const child of args) if (child) owner.sprites.add(child); });
      patch(container, "addChildAt", (owner, result, args) => { if (args[0]) owner.sprites.add(args[0]); });

      // Box2D asks the contact filter when two shape proxies start to overlap.
      // Wrapping it lets ghosted players pass through each other.
      const originalFilter = world.m_contactFilter ?? null;
      const contactFilter = {
        ShouldCollide(shape1, shape2) {
          const collide = originalFilter ? originalFilter.ShouldCollide(shape1, shape2) : defaultShouldCollide(shape1, shape2);
          return Boolean(collide) && !ghostedPair(contextRef, shape1, shape2);
        },
      };
      if (typeof world.SetContactFilter === "function") {
        world.SetContactFilter(contactFilter);
        contextRef.contactFilter = { world, original: originalFilter, wrapper: contactFilter };
      }
      contextRef.hookedWorld = world;
      contextRef.hookedContainer = container;
    }

    function removeOwnershipHooks(contextRef) {
      for (const { target, name, original, hadOwn, wrapper } of contextRef.ownershipPatches.splice(0)) {
        try {
          if (target[name] !== wrapper) continue;
          if (hadOwn) target[name] = original;
          else delete target[name];
        } catch { /* The world or container may already be destroyed. */ }
      }
      const filter = contextRef.contactFilter;
      if (filter) {
        try {
          if (filter.world.m_contactFilter === filter.wrapper) filter.world.SetContactFilter(filter.original);
        } catch { /* The world may already be destroyed. */ }
        contextRef.contactFilter = null;
      }
      contextRef.hookedWorld = null;
      contextRef.hookedContainer = null;
    }

    function defaultShouldCollide(shape1, shape2) {
      const filter1 = shape1.GetFilterData();
      const filter2 = shape2.GetFilterData();
      if (filter1.groupIndex === filter2.groupIndex && filter1.groupIndex !== 0) return filter1.groupIndex > 0;
      return (filter1.maskBits & filter2.categoryBits) !== 0 && (filter1.categoryBits & filter2.maskBits) !== 0;
    }

    // Every player shape uses category 0x104; level objects never set bit 0x100.
    const playerCategoryBit = 0x100;

    function isPlayerShape(shape) {
      try { return (shape.GetFilterData().categoryBits & playerCategoryBit) !== 0; } catch { return false; }
    }

    // A remote actor's bodies map to its entry; other player shapes (the local
    // character, or a level NPC) count as "local".
    function playerKey(contextRef, shape) {
      const owner = contextRef.bodyOwners.get(shape?.m_body ?? shape?.GetBody?.());
      if (owner) return owner;
      return isPlayerShape(shape) ? "local" : null;
    }

    function ghostedPair(contextRef, shape1, shape2) {
      const key1 = playerKey(contextRef, shape1);
      const key2 = playerKey(contextRef, shape2);
      if (!key1 || !key2 || key1 === key2) return false;
      return Boolean((key1 !== "local" && key1.ghosts.has(key2)) || (key2 !== "local" && key2.ghosts.has(key1)));
    }

    function shapeList(body) {
      try { return listItems(body.GetShapeList?.() ?? body.m_shapeList); } catch { return []; }
    }

    // Distance from the body origin to the farthest point of its shapes (metres).
    const bodyRadii = new WeakMap();
    function bodyRadius(body) {
      if (bodyRadii.has(body)) return bodyRadii.get(body);
      let radius = 0;
      for (const shape of shapeList(body)) {
        if (Array.isArray(shape.m_vertices)) {
          const count = Number.isInteger(shape.m_vertexCount) ? shape.m_vertexCount : shape.m_vertices.length;
          for (const vertex of shape.m_vertices.slice(0, count)) radius = Math.max(radius, Math.hypot(vertex.x, vertex.y));
        } else if (Number.isFinite(shape.m_radius)) {
          radius = Math.max(radius, Math.hypot(shape.m_localPosition?.x ?? 0, shape.m_localPosition?.y ?? 0) + shape.m_radius);
        } else {
          radius = Math.max(radius, 1);
        }
      }
      bodyRadii.set(body, radius);
      return radius;
    }

    function bodiesTouch(bodiesA, bodiesB) {
      for (const bodyA of bodiesA) {
        const a = bodyA.GetPosition();
        const radiusA = bodyRadius(bodyA) + 0.1;
        for (const bodyB of bodiesB) {
          const b = bodyB.GetPosition();
          if (Math.hypot(a.x - b.x, a.y - b.y) < radiusA + bodyRadius(bodyB)) return true;
        }
      }
      return false;
    }

    // A pair stops being ghosted once no body of one is near a body of the
    // other; from then on Box2D creates contacts for them normally.
    function updateGhosts(contextRef) {
      const ghosted = [...contextRef.extras.values()].filter((entry) => entry.ghosts.size);
      if (!ghosted.length) return;
      const world = contextRef.session.m_world;
      const alive = new Set(liveBodies(world));
      const localBodies = [...alive].filter((body) => !contextRef.bodyOwners.has(body) && shapeList(body).some(isPlayerShape));
      for (const entry of ghosted) {
        const own = [...entry.bodies].filter((body) => alive.has(body));
        for (const other of [...entry.ghosts]) {
          const others = other === "local" ? localBodies : [...other.bodies].filter((body) => alive.has(body));
          if (bodiesTouch(own, others)) continue;
          entry.ghosts.delete(other);
          if (other !== "local") other.ghosts.delete(entry);
        }
      }
    }

    function asOwner(contextRef, entry, callback) {
      const previous = contextRef.owner;
      contextRef.owner = entry;
      try { return callback(); } finally { contextRef.owner = previous; }
    }

    function removeActor(contextRef, entry) {
      for (const other of contextRef.extras.values()) other.ghosts?.delete(entry);
      try { entry.actor?.die?.(); } catch { /* die() only clears references; cleanup continues below. */ }
      // After a level restart or level change the old world is already discarded.
      const world = entry.world;
      if (world && world === contextRef.session.m_world && currentSession() === contextRef.session) {
        const joints = new Set(liveJoints(world));
        for (const joint of entry.joints) {
          if (joints.has(joint)) try { world.DestroyJoint(joint); } catch { /* Keep removing the rest. */ }
        }
        const bodies = new Set(liveBodies(world));
        for (const body of entry.bodies) {
          if (bodies.has(body)) try { world.DestroyBody(body); } catch { /* Keep removing the rest. */ }
        }
      }
      for (const sprite of entry.sprites) {
        try { sprite.parent?.removeChild?.(sprite); } catch { /* Already removed by the session cleanup. */ }
      }
      entry.bodies.clear();
      entry.joints.clear();
      entry.sprites.clear();
      entry.ghosts.clear();
    }

    function releaseContext() {
      if (!context) return;
      for (const entry of context.extras.values()) removeActor(context, entry);
      for (const [name, patch] of context.patches) {
        try {
          if (context.primary[name] === patch.wrapper) context.primary[name] = patch.original;
        } catch { /* The original session may already be gone. */ }
      }
      removeOwnershipHooks(context);
      context.extras.clear();
      context = null;
      failedPeers.clear();
      lastError = "";
    }

    function setError(error) {
      const message = error?.message ? String(error.message) : String(error);
      lastError = message.slice(0, 220);
    }

    function keyIsDown(peer, key) {
      return Array.isArray(peer.keys) && peer.keys.includes(key);
    }

    function applyPeerKeys(actor, peer) {
      actor.leftPressed = keyIsDown(peer, "left");
      actor.rightPressed = keyIsDown(peer, "right");
      actor.upPressed = keyIsDown(peer, "up");
      actor.downPressed = keyIsDown(peer, "down");
      actor.spacePressed = keyIsDown(peer, "space") || keyIsDown(peer, "jump") || keyIsDown(peer, "action");
      actor.shiftPressed = keyIsDown(peer, "shift");
      actor.ctrlPressed = keyIsDown(peer, "ctrl");
      actor.zPressed = keyIsDown(peer, "z");
    }

    function invokeRemote(contextRef, methodName) {
      for (const entry of contextRef.extras.values()) {
        const method = entry.actor?.[methodName];
        if (typeof method !== "function") {
          if (methodName === "checkKeyStates") setError("El personaje remoto no tiene " + methodName + "().");
          continue;
        }
        try {
          if (methodName === "checkKeyStates") applyPeerKeys(entry.actor, entry.peer);
          asOwner(contextRef, entry, () => method.call(entry.actor));
        } catch (error) {
          setError(entry.peer.name + ": " + (error?.message ?? error));
        }
      }
    }

    function hookSession(session) {
      if (context?.session === session && context.primary === session._character) {
        // Restarting the level builds a new Box2D world and resets the primary in place.
        if (context.world !== session.m_world) {
          for (const entry of context.extras.values()) removeActor(context, entry);
          context.extras.clear();
          failedPeers.clear();
          context.world = session.m_world;
        }
        installOwnershipHooks(context);
        return context;
      }
      releaseContext();

      const primary = session._character;
      const requiredMethods = ["preActions", "checkKeyStates", "actions", "handleContactBuffer", "checkJoints", "paint"];
      const missing = requiredMethods.filter((name) => typeof primary[name] !== "function");
      if (missing.length) throw new Error("Faltan fases nativas del personaje: " + missing.join(", "));

      const newContext = {
        session, primary, world: session.m_world, extras: new Map(), slots: new Map(), patches: new Map(),
        ownershipPatches: [], hookedWorld: null, hookedContainer: null, owner: null,
        bodyOwners: new WeakMap(), contactFilter: null,
      };
      context = newContext;
      installOwnershipHooks(newContext);
      for (const name of requiredMethods) {
        const original = primary[name];
        const wrapper = function () {
          const result = original.apply(this, arguments);
          invokeRemote(newContext, name);
          return result;
        };
        primary[name] = wrapper;
        newContext.patches.set(name, { original, wrapper });
      }
      return newContext;
    }

    function allocateSlot(contextRef, playerId) {
      if (contextRef.slots.has(playerId)) return contextRef.slots.get(playerId);
      const used = new Set(contextRef.slots.values());
      let slot = 0;
      while (used.has(slot) && slot < 7) slot += 1;
      if (slot > 6) throw new Error("La sala permite como máximo siete personajes remotos.");
      contextRef.slots.set(playerId, slot);
      return slot;
    }

    function releasePeer(contextRef, playerId) {
      const entry = contextRef.extras.get(playerId);
      if (entry) {
        removeActor(contextRef, entry);
        contextRef.extras.delete(playerId);
      }
      contextRef.slots.delete(playerId);
      failedPeers.delete(playerId);
    }

    function makeSource(characterIndex, version) {
      const assetFactory = module(98263);
      const Source = module(4971)?.j7;
      if (typeof assetFactory?.zI !== "function") throw new Error("No se encontró el cargador de personajes del juego (98263.zI).");
      if (typeof Source !== "function") throw new Error("No se encontró el wrapper nativo de personajes (4971.j7).");
      const modernVersion = Number(version) >= 1.11;
      const preferredName = "Character" + characterIndex + (modernVersion ? "V111" : "");
      const names = [preferredName];
      for (const fallback of ["Character" + characterIndex + "V111", "Character" + characterIndex, "Character" + characterIndex + "V1.11"]) {
        if (!names.includes(fallback)) names.push(fallback);
      }
      for (const name of names) {
        let raw;
        try { raw = assetFactory.zI(name); } catch { raw = null; }
        if (!raw) continue;
        const source = new Source();
        if (typeof source.setPixiMovieClip !== "function" || typeof source.convertChildren !== "function") {
          throw new Error("El wrapper nativo no expone la inicialización MovieClip esperada.");
        }
        source.setPixiMovieClip(raw);
        source.convertChildren(raw);
        return { source, modern: name.includes("V111") || name.includes("V1.11") };
      }
      throw new Error("No se encontró el asset gráfico del personaje " + characterIndex + ".");
    }

    function createActor(contextRef, peer, slot) {
      const characterModule = module(34531);
      const index = Number.isInteger(peer.characterIndex) && peer.characterIndex >= 1 && peer.characterIndex <= 11
        ? peer.characterIndex : 1;
      const selectedAsset = makeSource(index, contextRef.session.version);
      const exportName = !selectedAsset.modern && oldCharacterExports[index]
        ? oldCharacterExports[index]
        : characterExports[index];
      const Character = characterModule?.[exportName];
      if (typeof Character !== "function") throw new Error("No se encontró el personaje jugable " + index + " (" + exportName + ").");

      // Build it exactly like Session.setupCharacter does. The tag prefixes the
      // character's voice sounds, so it must stay the native one.
      const session = contextRef.session;
      const start = startPosition(session);
      const actor = index === 10
        ? new Character(start.x, start.y, selectedAsset.source, session, -1, "Char4")
        : new Character(start.x, start.y, selectedAsset.source, session);
      silenceStats(actor);
      const entry = {
        actor,
        source: selectedAsset.source,
        peer: { ...peer, characterIndex: index },
        slot,
        world: session.m_world,
        bodies: new Set(),
        joints: new Set(),
        sprites: new Set(),
        // Spawning on top of other players would make the ragdolls explode, so
        // the new actor ignores them until they no longer overlap.
        ghosts: new Set(["local", ...contextRef.extras.values()]),
        groupBase: -1000 - 100 * slot,
        spawn: null,
      };
      for (const other of contextRef.extras.values()) other.ghosts.add(entry);
      try {
        asOwner(contextRef, entry, () => actor.create());
        // The standard vehicle is built into the character class. userVehicle
        // is optional and refers to a custom vehicle from the level editor.
        if (typeof actor.checkKeyStates !== "function" || typeof actor.paint !== "function" || entry.bodies.size === 0) {
          throw new Error("El personaje " + index + " no creó sus cuerpos o controles nativos.");
        }
        isolateGroups(entry);
        entry.spawn = moveActorTo(entry, actorPosition(contextRef.primary) ?? start);
        asOwner(contextRef, entry, () => actor.paint());
      } catch (error) {
        removeActor(contextRef, entry);
        throw error;
      }
      return entry;
    }

    // Players share negative collision groups natively (-1 for the adult, -6
    // for the lower body, -2/-3 for kids), so two players could never touch.
    // Each remote gets its own range; levels only use groups down to -322.
    function remapGroup(group, base) {
      return group < 0 && group > -100 ? base + group : group;
    }

    function companions(actor) {
      return Object.values(actor).filter((value) => value && value !== actor && typeof value === "object" &&
        typeof value.createFilters === "function" && value._session === actor._session);
    }

    function isolateGroups(entry) {
      // Filter templates are reused later when limbs break or riders eject.
      for (const owner of [entry.actor, ...companions(entry.actor)]) {
        for (const value of Object.values(owner)) {
          if (value && typeof value === "object" && Number.isFinite(value.groupIndex) &&
              Number.isFinite(value.categoryBits) && Number.isFinite(value.maskBits)) {
            value.groupIndex = remapGroup(value.groupIndex, entry.groupBase);
          }
        }
      }
      for (const body of entry.bodies) {
        for (const shape of shapeList(body)) {
          const filter = shape.GetFilterData();
          const group = remapGroup(filter.groupIndex, entry.groupBase);
          if (group === filter.groupIndex) continue;
          filter.groupIndex = group;
          shape.SetFilterData(filter);
          entry.world.Refilter(shape);
        }
      }
    }

    // Shifts every body of a freshly created actor so its focus body lands on
    // the target point (pixels). Joints keep their local anchors, so the
    // ragdoll and its vehicle move as one piece.
    function moveActorTo(entry, target) {
      const scale = physScale(entry.actor);
      const current = actorPosition(entry.actor);
      if (current && target) {
        const dx = (target.x - current.x) / scale;
        const dy = (target.y - current.y) / scale;
        if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
          for (const body of entry.bodies) {
            const position = body.GetPosition();
            const Vector = position.constructor;
            body.SetXForm(new Vector(position.x + dx, position.y + dy), body.GetAngle());
          }
        }
      }
      // New bodies start with an interpolated position of (0, 0) until the next
      // presented frame; without this the first paint puts the sprites at the
      // level origin.
      for (const body of entry.bodies) {
        try { body.UpdateInterpolation?.(1); } catch { /* Older builds have no interpolation. */ }
      }
      return actorPosition(entry.actor);
    }

    function syncPeers(session) {
      if (!sessionIsReady(session)) return null;
      const contextRef = hookSession(session);
      const desired = new Map(desiredPeers
        .filter((peer) => peer && typeof peer.id === "string" && peer.id !== selfId)
        .map((peer) => [peer.id, peer]));
      for (const playerId of [...contextRef.slots.keys()]) {
        if (!desired.has(playerId)) releasePeer(contextRef, playerId);
      }
      for (const [playerId, peer] of desired) {
        const index = Number.isInteger(peer.characterIndex) ? peer.characterIndex : 1;
        const existing = contextRef.extras.get(playerId);
        if (existing && existing.peer.characterIndex === index) {
          existing.peer = { ...peer, characterIndex: index };
          continue;
        }
        if (existing) releasePeer(contextRef, playerId);
        const signature = String(index);
        if (failedPeers.get(playerId) === signature) continue;
        try {
          const slot = allocateSlot(contextRef, playerId);
          contextRef.extras.set(playerId, createActor(contextRef, peer, slot));
          failedPeers.delete(playerId);
        } catch (error) {
          failedPeers.set(playerId, signature);
          setError((peer.name || playerId) + ": " + (error?.message ?? error));
        }
      }
      if (failedPeers.size === 0) lastError = "";
      return contextRef;
    }

    function setPeers(nextSelfId, peers) {
      selfId = typeof nextSelfId === "string" ? nextSelfId : null;
      desiredPeers = Array.isArray(peers) ? peers.map((peer) => ({
        id: String(peer.id || ""),
        name: String(peer.name || "Jugador").slice(0, 24),
        characterIndex: Number.isInteger(peer.characterIndex) ? peer.characterIndex : 1,
        keys: Array.isArray(peer.keys) ? peer.keys.filter((key) => typeof key === "string") : [],
      })) : [];
      const session = currentSession();
      if (sessionIsReady(session)) syncPeers(session);
      else if (context) releaseContext();
      return status();
    }

    function status() {
      try {
        const session = currentSession();
        if (!sessionIsReady(session)) {
          if (context) releaseContext();
          return { ready: false, players: 0, remotes: 0, error: lastError, menu: menuInfo() };
        }
        const contextRef = syncPeers(session);
        updateGhosts(contextRef);
        // Session.setupCharacter reads the selection from the global settings.
        const selected = settings()?.characterIndex;
        const characterIndex = Number.isInteger(selected) && selected >= 1 && selected <= 11 ? selected : 1;
        return {
          ready: true,
          players: 1 + contextRef.extras.size,
          remotes: contextRef.extras.size,
          characterIndex,
          bodies: liveBodies(session.m_world).length,
          joints: liveJoints(session.m_world).length,
          error: lastError,
        };
      } catch (error) {
        setError(error);
        return { ready: false, players: 0, remotes: 0, error: lastError };
      }
    }

    function gameController() {
      return module(19369)?.l?.instance?.tempGameScreen?.happyWheels ?? null;
    }

    function menuInfo() {
      try {
        const rootApp = module(19369)?.l?.instance;
        const game = gameController();
        const menu = game?.mainMenu;
        const describeButton = (name) => {
          const button = menu?.[name];
          if (!button) return null;
          let global = null;
          let bounds = null;
          try {
            const point = button.getGlobalPosition?.();
            if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) global = { x: point.x, y: point.y };
          } catch { /* PIXI may not have laid out this control yet. */ }
          try {
            const rect = button.getBounds?.();
            if (Number.isFinite(rect?.x) && Number.isFinite(rect?.y)) bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          } catch { /* Some controls only have local coordinates before layout. */ }
          const prototype = Object.getPrototypeOf(button) || {};
          return {
            constructorName: button.constructor?.name ?? null,
            ownFunctionKeys: Object.keys(button).filter((key) => typeof button[key] === "function").slice(0, 12),
            prototypeMethods: Object.getOwnPropertyNames(prototype).filter((key) => key !== "constructor" && typeof button[key] === "function").slice(0, 16),
            name: button.name ?? name,
            label: button.label?.text ?? button.text ?? button._text ?? null,
            x: button.x ?? null,
            y: button.y ?? null,
            global,
            bounds,
            width: button.width ?? null,
            height: button.height ?? null,
            visible: button.visible ?? null,
            interactive: button.interactive ?? null,
            eventNames: button._events ? Object.keys(button._events) : [],
          };
        };
        return {
          appReady: Boolean(game),
          hostname: window.location.hostname,
          gameMenuClass: menu?.constructor?.name ?? null,
          gameMenuMethods: menu ? Object.getOwnPropertyNames(Object.getPrototypeOf(menu) || {}).filter((key) => key !== "constructor" && typeof menu[key] === "function").filter((key) => /play|load|enter|session|level|start/i.test(key)).slice(0, 20) : [],
          rootKeys: rootApp ? Object.keys(rootApp).filter((key) => /menu|level|session|screen/i.test(key)).slice(0, 24) : [],
          gameKeys: game ? Object.keys(game).filter((key) => /menu|level|session|screen/i.test(key)).slice(0, 32) : [],
          gameMethods: game ? Object.getOwnPropertyNames(Object.getPrototypeOf(game) || {}).filter((key) => /menu|level|session|init/i.test(key)).slice(0, 32) : [],
          mainMenuOpen: Boolean(menu),
          menuKeys: menu ? Object.keys(menu).slice(0, 40) : [],
          buttons: {
            play: describeButton("playBtn"),
            browse: describeButton("browseBtn"),
            loadLevel: describeButton("loadLevelBtn"),
          },
          viewport: { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio },
        };
      } catch (error) {
        return { error: error?.message ?? String(error) };
      }
    }

    function inspect() {
      const current = status();
      const session = currentSession();
      return {
        ...current,
        menu: menuInfo(),
        start: sessionIsReady(session) ? startPosition(session) : null,
        localPosition: session?._character ? actorPosition(session._character) : null,
        actors: context ? [...context.extras.values()].map((entry) => {
          const container = context.session.containerSprite;
          const chest = entry.actor.chestMC;
          return {
            name: entry.peer.name,
            characterIndex: entry.peer.characterIndex,
            keys: entry.peer.keys,
            spawn: entry.spawn,
            position: actorPosition(entry.actor),
            chestSprite: chest ? { x: chest.x, y: chest.y, visible: chest.visible ?? null, attached: chest.parent === container } : null,
            bodies: entry.bodies.size,
            joints: entry.joints.size,
            sprites: entry.sprites.size,
            spritesAttached: [...entry.sprites].filter((sprite) => sprite.parent === container).length,
            dead: Boolean(entry.actor.dead),
            groupBase: entry.groupBase,
            ghostedWith: [...entry.ghosts].map((other) => other === "local" ? "local" : other.peer.name),
            customVehicle: entry.actor.userVehicle?.constructor?.name ?? null,
          };
        }) : [],
      };
    }

    function openMainMenu() {
      if (sessionIsReady(currentSession())) return { ok: false, error: "Cierra o termina el nivel antes de volver al menú." };
      const game = gameController();
      if (!game || typeof game.openMainMenu !== "function") return { ok: false, error: "El controlador Happy Wheels de la pantalla temporal todavía no está inicializado." };
      if (!game.mainMenu) game.openMainMenu();
      return { ok: true, menu: menuInfo() };
    }

    async function activateMenuButton(name) {
      const game = gameController();
      const button = game?.mainMenu?.[name];
      if (!button || typeof button.getBounds !== "function") return { ok: false, error: "No se encontró el botón nativo " + name + "." };
      const canvas = document.querySelector("canvas");
      if (!canvas) return { ok: false, error: "No se encontró el canvas del juego." };
      const bounds = button.getBounds();
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0 && canvas.width > 0 && canvas.height > 0)) {
        return { ok: false, error: "El canvas todavía no tiene tamaño visible." };
      }
      const clientX = rect.left + ((bounds.x + bounds.width / 2) / canvas.width) * rect.width;
      const clientY = rect.top + ((bounds.y + bounds.height / 2) / canvas.height) * rect.height;
      const init = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 1 };
      if (typeof PointerEvent === "function") {
        canvas.dispatchEvent(new PointerEvent("pointermove", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        canvas.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        canvas.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
      }
      canvas.dispatchEvent(new MouseEvent("mousemove", { ...init, buttons: 0 }));
      canvas.dispatchEvent(new MouseEvent("mousedown", init));
      canvas.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
      canvas.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const session = currentSession();
      return {
        ok: true,
        name,
        screenPoint: { x: clientX, y: clientY },
        canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, pixelWidth: canvas.width, pixelHeight: canvas.height },
        buttonBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        sessionReady: sessionIsReady(session),
        sessionPresent: Boolean(session),
        levelPresent: Boolean(session?.level),
      };
    }

    async function openLoadLevelMenu() {
      const game = gameController();
      const menu = game?.mainMenu;
      if (!menu || typeof menu.openLoadLevelMenu !== "function") {
        return { ok: false, error: "El menú nativo no ofrece el selector de nivel." };
      }
      try {
        const returned = menu.openLoadLevelMenu();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const nodes = [];
        const visit = (node, path, depth) => {
          if (!node || depth > 4 || nodes.length >= 24) return;
          let bounds = null;
          try { const rect = node.getBounds?.(); if (Number.isFinite(rect?.x) && Number.isFinite(rect?.y)) bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; } catch {}
          nodes.push({ path, bounds, visible: node.visible ?? null, interactive: node.interactive ?? null, children: node.children?.length ?? 0, keys: Object.keys(node).filter((key) => /text|label|button|input|load|level|id|click|value|close/i.test(key)).slice(0, 6) });
          for (let i = 0; i < (node.children?.length ?? 0); i++) visit(node.children[i], path + "." + i, depth + 1);
        };
        const modalIndex = (menu.children?.length ?? 0) - 1;
        if (modalIndex >= 0) visit(menu.children[modalIndex], "menu." + modalIndex, 0);
        const domInputs = [...document.querySelectorAll("input,textarea,select")]
          .filter((element) => element.getRootNode()?.host?.id !== "happy-wheels-lan-overlay")
          .slice(0, 4);
        const input = domInputs[domInputs.length - 1];
        if (input) {
          input.value = "1";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.focus();
          if (input.form?.requestSubmit) input.form.requestSubmit();
          else {
            for (const type of ["keydown", "keypress", "keyup"]) {
              input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const session = currentSession();
        const inputRect = input?.getBoundingClientRect();
        return {
          ok: true,
          input: input ? { type: input.type ?? null, value: input.value ?? null, rect: inputRect ? { x: inputRect.x, y: inputRect.y, width: inputRect.width, height: inputRect.height } : null, form: Boolean(input.form) } : null,
          controls: nodes.filter((node) => node.path.split(".").length === 3 || (node.interactive && node.path.split(".").length > 3)).slice(0, 12).map((node) => ({ path: node.path, bounds: node.bounds, visible: node.visible, interactive: node.interactive, children: node.children })),
          sessionPresent: Boolean(session),
          sessionReady: sessionIsReady(session),
          levelPresent: Boolean(session?.level),
          worldPresent: Boolean(session?.m_world),
        };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    }

    async function loadLevel(levelId = 13196) {
      if (sessionIsReady(currentSession())) return { ok: false, error: "Ya hay un nivel activo." };
      if (!Number.isSafeInteger(levelId) || levelId < 1) return { ok: false, error: "ID de nivel inválido." };
      const game = gameController();
      if (!game || typeof game.loadLevelByID !== "function") return { ok: false, error: "El controlador Happy Wheels todavía no está inicializado." };
      try {
        if (game.mainMenu) game.closeMainMenu();
        game.loadLevelByID(levelId);
        const deadline = Date.now() + 20000;
        while (!sessionIsReady(currentSession()) && Date.now() < deadline) {
          const controller = game.sessionController;
          if (controller?.characterMenu && typeof controller.loadSession === "function") await controller.loadSession();
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return { ok: sessionIsReady(currentSession()), levelId, sessionReady: sessionIsReady(currentSession()), error: sessionIsReady(currentSession()) ? "" : "El nivel no terminó de cargar en 20 segundos." };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    }

    function respawnPeers() {
      releaseContext();
      return status();
    }

    return { setPeers, status, inspect, openMainMenu, openLoadLevelMenu, activateMenuButton, loadLevel, respawnPeers, dispose: releaseContext };
  }

  const nativeBridgeProbe = "(() => {" +
    "const bridgeKey='__HW_LAN_NATIVE_BRIDGE__';" +
    "if(window[bridgeKey]) return window[bridgeKey].status();" +
    "const queue=(" + findWebpackQueue.toString() + ")();" +
    "if(!queue||typeof queue.push!=='function') return {ready:false,waiting:'assets'};" +
    "if(window.__HW_LAN_NATIVE_QUEUED__) return {ready:false,waiting:'webpack'};" +
    "window.__HW_LAN_NATIVE_QUEUED__=true;" +
    "try { queue.push([[2147483629],{},(webpackRequire)=>{" +
      "try { window[bridgeKey]=(" + installNativeBridge.toString() + ")(webpackRequire); }" +
      "catch(error) { window.__HW_LAN_NATIVE_ERROR__=error.message||String(error); window.__HW_LAN_NATIVE_QUEUED__=false; }" +
    "}]); } catch(error) { window.__HW_LAN_NATIVE_QUEUED__=false; return {ready:false,error:error.message}; }" +
    "return window[bridgeKey]?window[bridgeKey].status():{ready:false,waiting:'webpack'};" +
  "})()";
  const nativeStatusProbe = "(() => { const bridge=window.__HW_LAN_NATIVE_BRIDGE__; return bridge?bridge.status():null; })()";

  const root = document.createElement("div");
  root.id = "happy-wheels-lan-overlay";
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const shadow = root.attachShadow({ mode: "open" });
  shadow.innerHTML = [
    "<style>",
    ":host{all:initial;color-scheme:dark;font:13px/1.35 system-ui,sans-serif}",
    "*{box-sizing:border-box}",
    "#panel{position:fixed;top:12px;right:12px;width:min(360px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:12px;color:#eff7ff;background:rgba(12,19,30,.92);border:1px solid rgba(125,215,255,.65);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);pointer-events:auto;backdrop-filter:blur(8px)}",
    "header{display:flex;align-items:center;justify-content:space-between;gap:8px}",
    "header strong{letter-spacing:.04em;color:#7dd7ff;font-size:12px}",
    "label{display:block;margin-top:9px;color:#b4c2d4;font-size:11px}",
    "input{display:block;width:100%;margin-top:3px;border:1px solid #40536a;border-radius:5px;padding:7px 8px;color:#eff7ff;background:#101a27;font:inherit}",
    ".row{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
    "button{margin-top:10px;border:0;border-radius:5px;padding:7px 10px;color:#07111b;background:#7dd7ff;font:inherit;font-weight:700;cursor:pointer}",
    "button.secondary{color:#eaf3fb;background:#34475e}",
    "button:disabled{opacity:.5;cursor:default}",
    "#network{display:block;min-height:18px;margin-top:9px;color:#ffd166;font-size:12px}",
    "#native{display:block;margin-top:6px;color:#ffd166;font-size:11px}",
    "#players{display:grid;gap:3px;margin:7px 0 0;padding:0;list-style:none}",
    "#players li{display:flex;justify-content:space-between;gap:8px;padding:4px 6px;border-radius:4px;background:rgba(255,255,255,.06);font-size:11px}",
    "#players .you{color:#84e2a2}",
    "small{display:block;margin-top:8px;color:#b4c2d4;font-size:10px}",
    "details{margin-top:8px;color:#b4c2d4;font-size:10px}",
    "pre{max-height:30vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:#c5d5e7;font:10px/1.35 ui-monospace,monospace}",
    "</style>",
    "<section id=\"panel\">",
    "<header><strong>HAPPY WHEELS · MULTIPLAYER NATIVO</strong><button id=\"disconnect\" class=\"secondary\" type=\"button\" disabled>Salir</button></header>",
    "<label>Servidor WebSocket<input id=\"server\" spellcheck=\"false\" value=\"ws://127.0.0.1:8765/ws\"></label>",
    "<div class=\"row\"><label>Sala<input id=\"room\" maxlength=\"32\" value=\"happy-wheels\"></label><label>Nombre<input id=\"name\" maxlength=\"24\" value=\"Jugador\"></label></div>",
    "<button id=\"connect\" type=\"button\">Conectar</button>",
    "<button id=\"play-game\" class=\"secondary\" type=\"button\">Abrir BMX Park II</button>",
    "<button id=\"respawn\" class=\"secondary\" type=\"button\">Reaparecer jugadores</button>",
    "<output id=\"network\" aria-live=\"polite\">Desconectado. Inicia primero el servidor.</output>",
    "<output id=\"native\">Esperando el motor y un nivel jugable…</output>",
    "<ul id=\"players\"></ul>",
    "<small>Abre el mismo nivel en cada equipo. Flechas, Espacio, Shift, Ctrl y Z controlan tu personaje.</small>",
    "<details><summary>Diagnóstico de actores y físicas</summary><button id=\"open-menu\" class=\"secondary\" type=\"button\">Inicializar menú del juego</button><button id=\"reload-bridge\" class=\"secondary\" type=\"button\">Recargar código local</button><button id=\"inspect\" class=\"secondary\" type=\"button\">Actualizar diagnóstico</button><pre id=\"details\"></pre></details>",
    "</section>",
  ].join("");

  const serverInput = shadow.querySelector("#server");
  const roomInput = shadow.querySelector("#room");
  const nameInput = shadow.querySelector("#name");
  const connectButton = shadow.querySelector("#connect");
  const disconnectButton = shadow.querySelector("#disconnect");
  const networkOutput = shadow.querySelector("#network");
  const nativeOutput = shadow.querySelector("#native");
  const playersElement = shadow.querySelector("#players");
  const inspectButton = shadow.querySelector("#inspect");
  const openMenuButton = shadow.querySelector("#open-menu");
  const reloadBridgeButton = shadow.querySelector("#reload-bridge");
  const respawnButton = shadow.querySelector("#respawn");
  const playGameButton = shadow.querySelector("#play-game");
  const detailsElement = shadow.querySelector("#details");
  const remotePeers = new Map();
  const heldKeys = new Set();
  let socket = null;
  let selfId = null;
  let inputSequence = 0;
  let nativeReady = false;
  let checking = false;
  let inspectBusy = false;
  let lastAdvertisedCharacter = null;
  let nativeSyncPending = false;
  let nativeSyncRequested = false;
  let nativeSyncPromise = Promise.resolve();
  let diagnosticTitle = null;

  function exposeDiagnostic(kind, value) {
    const title = "HW_" + kind + ":" + encodeURIComponent(JSON.stringify(value)).slice(0, 10000);
    diagnosticTitle = title;
    setTimeout(() => { if (diagnosticTitle === title) diagnosticTitle = null; }, 15000);
  }

  const keyCodes = new Map([
    ["ArrowLeft", "left"], ["KeyA", "left"],
    ["ArrowRight", "right"], ["KeyD", "right"],
    ["ArrowUp", "up"], ["KeyW", "up"],
    ["ArrowDown", "down"], ["KeyS", "down"],
    ["Space", "space"], ["ShiftLeft", "shift"], ["ShiftRight", "shift"],
    ["ControlLeft", "ctrl"], ["ControlRight", "ctrl"], ["KeyZ", "z"],
  ]);
  const characterNames = ["", "Wheelchair Guy", "Segway Guy", "Irresponsible Dad", "Effective Shopper", "Moped Couple", "Lawnmower Man", "Explorer Guy", "Santa Claus", "Pogostick Man", "Irresponsible Mom", "Helicopter Man"];

  function setNetwork(message, connected = false) {
    networkOutput.value = message;
    networkOutput.style.color = connected ? "#84e2a2" : "#ffd166";
  }

  function bridgePayload() {
    return {
      selfId,
      peers: [...remotePeers.values()].map((peer) => ({
        id: peer.id,
        name: peer.name,
        characterIndex: peer.characterIndex,
        keys: peer.keys || [],
      })),
    };
  }

  function syncNativePeers() {
    nativeSyncRequested = true;
    renderPlayers();
    if (!nativeSyncPending) {
      nativeSyncPending = true;
      nativeSyncPromise = (async () => {
        while (nativeSyncRequested) {
          nativeSyncRequested = false;
          const encoded = JSON.stringify(JSON.stringify(bridgePayload()));
          const code = "(() => { const bridge=window.__HW_LAN_NATIVE_BRIDGE__; if(bridge) return bridge.setPeers(JSON.parse(" + encoded + ").selfId, JSON.parse(" + encoded + ").peers); return null; })()";
          try { await webFrame.executeJavaScript(code); } catch { /* The game can still be loading its webpack runtime. */ }
        }
      })().finally(() => { nativeSyncPending = false; });
    }
    return nativeSyncPromise;
  }

  function renderPlayers() {
    playersElement.replaceChildren();
    if (selfId) {
      const own = document.createElement("li");
      own.className = "you";
      const name = nameInput.value.trim() || "Tú";
      const left = document.createElement("span");
      const right = document.createElement("span");
      left.textContent = name + " (tú)";
      right.textContent = nativeReady ? "nativo" : "en sala";
      own.append(left, right);
      playersElement.append(own);
    }
    for (const peer of remotePeers.values()) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      const avatar = document.createElement("span");
      name.textContent = peer.name;
      avatar.textContent = characterNames[peer.characterIndex] || ("Personaje " + peer.characterIndex);
      item.append(name, avatar);
      playersElement.append(item);
    }
    if (selfId) networkOutput.dataset.count = String(remotePeers.size + 1);
  }

  function currentSocketUrl(value) {
    const url = new URL(value.trim());
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Usa ws:// o wss://.");
    if (!url.pathname || url.pathname === "/") url.pathname = "/ws";
    return url.toString();
  }

  function sendJson(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendInputState(force = false) {
    if (!selfId || socket?.readyState !== WebSocket.OPEN) return;
    const keys = [...heldKeys].sort();
    if (!force && sendInputState.lastKeys === keys.join(",")) return;
    sendInputState.lastKeys = keys.join(",");
    sendJson({ type: "input", seq: inputSequence++, keys });
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
    let url;
    const room = roomInput.value.trim();
    const name = nameInput.value.trim();
    if (!room || !name) {
      setNetwork("Escribe un nombre y una sala.");
      return;
    }
    try { url = currentSocketUrl(serverInput.value); } catch (error) {
      setNetwork(error.message);
      return;
    }
    setNetwork("Conectando con " + url + "…");
    connectButton.disabled = true;
    let ws;
    try { ws = new WebSocket(url); } catch (error) {
      connectButton.disabled = false;
      setNetwork("No se pudo abrir la conexión: " + error.message);
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      ws.send(JSON.stringify({ type: "join", room, name }));
      setNetwork("Conectado al servidor; entrando en la sala…");
    });
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "welcome") {
        selfId = message.self?.id || null;
        remotePeers.clear();
        for (const peer of message.peers || []) {
          if (!peer?.id) continue;
          remotePeers.set(peer.id, {
            id: peer.id,
            name: peer.name || "Jugador",
            characterIndex: peer.characterIndex || 1,
            keys: peer.input?.keys || [],
            inputSequence: Number.isInteger(peer.input?.seq) ? peer.input.seq : -1,
          });
        }
        inputSequence = 0;
        lastAdvertisedCharacter = null;
        setNetwork("En sala " + message.room + " · " + (remotePeers.size + 1) + "/8 jugadores.", true);
        disconnectButton.disabled = false;
        connectButton.disabled = true;
        sendInputState(true);
        syncNativePeers();
      } else if (message.type === "joined" && message.player?.id) {
        const peer = message.player;
        remotePeers.set(peer.id, {
          id: peer.id,
          name: peer.name || "Jugador",
          characterIndex: peer.characterIndex || 1,
          keys: peer.input?.keys || [],
          inputSequence: Number.isInteger(peer.input?.seq) ? peer.input.seq : -1,
        });
        setNetwork((remotePeers.size + 1) + "/8 jugadores en la sala.", true);
        syncNativePeers();
      } else if (message.type === "left") {
        remotePeers.delete(message.playerId);
        setNetwork((remotePeers.size + (selfId ? 1 : 0)) + "/8 jugadores en la sala.", true);
        syncNativePeers();
      } else if (message.type === "input") {
        const peer = remotePeers.get(message.playerId);
        if (peer && Number.isInteger(message.input?.seq) && message.input.seq > peer.inputSequence) {
          peer.inputSequence = message.input.seq;
          peer.keys = Array.isArray(message.input.keys) ? message.input.keys : [];
          syncNativePeers();
        }
      } else if (message.type === "avatar") {
        const peer = remotePeers.get(message.playerId);
        if (peer && Number.isInteger(message.characterIndex)) {
          peer.characterIndex = message.characterIndex;
          syncNativePeers();
        }
      } else if (message.type === "error") {
        setNetwork(message.message || "El servidor rechazó la conexión.");
      }
    });
    ws.addEventListener("error", () => {
      if (socket === ws) setNetwork("No se pudo conectar. Comprueba que el servidor esté iniciado y que la URL sea correcta.");
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      selfId = null;
      remotePeers.clear();
      lastAdvertisedCharacter = null;
      connectButton.disabled = false;
      disconnectButton.disabled = true;
      syncNativePeers();
      setNetwork(event.reason ? "Desconectado: " + event.reason : "Desconectado del servidor.");
    });
  }

  function disconnect() {
    sendJson({ type: "input", seq: inputSequence++, keys: [] });
    heldKeys.clear();
    sendInputState.lastKeys = "";
    if (socket) socket.close(1000, "player disconnected");
  }

  function eventIsInTextField() {
    const active = shadow.activeElement;
    return active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
  }

  function onKey(event, isDown) {
    if (eventIsInTextField()) return;
    const key = keyCodes.get(event.code);
    if (!key) return;
    const before = heldKeys.has(key);
    if (isDown) heldKeys.add(key);
    else heldKeys.delete(key);
    if (before !== heldKeys.has(key)) sendInputState();
  }

  document.addEventListener("keydown", (event) => onKey(event, true), true);
  document.addEventListener("keyup", (event) => onKey(event, false), true);
  window.addEventListener("blur", () => {
    if (heldKeys.size) {
      heldKeys.clear();
      sendInputState(true);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && heldKeys.size) {
      heldKeys.clear();
      sendInputState(true);
    }
  });

  async function refreshNativeState() {
    if (checking) return;
    checking = true;
    try {
      const probe = await webFrame.executeJavaScript(nativeBridgeProbe);
      await syncNativePeers();
      const state = await webFrame.executeJavaScript(nativeStatusProbe);
      nativeReady = Boolean(state?.ready);
      if (nativeReady) {
        const localCharacter = Number.isInteger(state.characterIndex) ? state.characterIndex : 1;
        nativeOutput.value = state.error
          ? "Error nativo: " + state.error
          : state.players + " personajes · " + state.bodies + " cuerpos · " + state.joints + " articulaciones.";
        if (selfId && localCharacter !== lastAdvertisedCharacter) {
          sendJson({ type: "avatar", characterIndex: localCharacter });
          lastAdvertisedCharacter = localCharacter;
        }
      } else {
        const error = state?.error || probe?.error;
        nativeOutput.value = error ? "Error nativo: " + error : "Conectado cuando abras un nivel jugable.";
      }
      renderPlayers();
      const menuSummary = state?.menu ? JSON.stringify({
        appReady: state.menu.appReady,
        appKeys: state.menu.appKeys,
        menuKeys: state.menu.menuKeys,
        buttons: state.menu.buttons,
        viewport: state.menu.viewport,
      }) : "";
      const titleData = [
        nativeReady ? "active" : "waiting-level",
        socket?.readyState === WebSocket.OPEN ? "online" : "offline",
        String(remotePeers.size + (selfId ? 1 : 0)),
        state?.error || "",
        menuSummary,
      ].join("|").slice(0, 1200);
      document.title = diagnosticTitle || ("HW_MP:" + encodeURIComponent(titleData));
    } catch (error) {
      nativeOutput.value = "Esperando el motor: " + error.message;
    } finally {
      checking = false;
    }
  }

  async function inspectNative() {
    if (inspectBusy) return;
    inspectBusy = true;
    inspectButton.disabled = true;
    try {
      const value = await webFrame.executeJavaScript("(() => { const bridge=window.__HW_LAN_NATIVE_BRIDGE__; return bridge ? bridge.inspect() : {ready:false,error:'bridge loading'}; })()");
      detailsElement.textContent = JSON.stringify(value, null, 2);
      exposeDiagnostic("INSPECT", value);
    } catch (error) {
      detailsElement.textContent = error.message;
    } finally {
      inspectBusy = false;
      inspectButton.disabled = false;
    }
  }

  async function openGameMenu() {
    try {
      await webFrame.executeJavaScript(nativeBridgeProbe);
      const result = await webFrame.executeJavaScript("(() => { const bridge=window.__HW_LAN_NATIVE_BRIDGE__; return bridge ? bridge.openMainMenu() : {ok:false,error:'bridge loading'}; })()");
      exposeDiagnostic("MENU", result);
      if (!result?.ok) nativeOutput.value = result?.error || "No se pudo abrir el menú.";
      else nativeOutput.value = "Menú inicializado. Elige un nivel jugable.";
    } catch (error) {
      nativeOutput.value = "No se pudo abrir el menú: " + error.message;
    }
  }

  async function loadDemoLevel() {
    try {
      await webFrame.executeJavaScript(nativeBridgeProbe);
      const result = await webFrame.executeJavaScript("(() => { const bridge=window.__HW_LAN_NATIVE_BRIDGE__; return bridge ? bridge.loadLevel(13196) : {ok:false,error:'bridge loading'}; })()");
      exposeDiagnostic("LEVEL", result);
      if (!result?.ok) nativeOutput.value = result?.error || "No se pudo cargar el nivel.";
      else nativeOutput.value = "Nivel listo.";
    } catch (error) {
      nativeOutput.value = "No se pudo cargar el nivel: " + error.message;
    }
  }

  async function playGameFromMenu() {
    return loadDemoLevel();
  }

  async function reloadNativeBridge() {
    try {
      const response = await fetch("http://127.0.0.1:8765/native-bridge.js", { cache: "no-store" });
      if (!response.ok) throw new Error("El servidor local no ofrece la recarga del puente.");
      const result = await webFrame.executeJavaScript(await response.text());
      await syncNativePeers();
      exposeDiagnostic("RELOAD", result);
      await refreshNativeState();
    } catch (error) {
      nativeOutput.value = error.message;
    }
  }

  async function respawnNativePeers() {
    try {
      const result = await webFrame.executeJavaScript("window.__HW_LAN_NATIVE_BRIDGE__?.respawnPeers()");
      exposeDiagnostic("SPAWN", result);
      await refreshNativeState();
    } catch (error) { nativeOutput.value = error.message; }
  }

  connectButton.addEventListener("click", connect);
  disconnectButton.addEventListener("click", disconnect);
  inspectButton.addEventListener("click", () => void inspectNative());
  openMenuButton.addEventListener("click", () => void openGameMenu());
  reloadBridgeButton.addEventListener("click", () => void reloadNativeBridge());
  respawnButton.addEventListener("click", () => void respawnNativePeers());
  playGameButton.addEventListener("click", () => void playGameFromMenu());
  // A focused overlay button would swallow Space (a game key) and click itself again.
  shadow.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (button) button.blur();
  });
  document.documentElement.append(root);
  void refreshNativeState();
  setInterval(refreshNativeState, 700);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
