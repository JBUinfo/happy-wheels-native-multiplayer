# Estado — 2026-10-08

## Resultado real

Se verificó en el juego instalado (versión 1.99.2-s, nivel BMX Park II, ID
13196) un nivel con el personaje local y dos jugadores remotos nativos:

- 3 personajes, 82 cuerpos y 87 articulaciones en el mismo mundo Box2D.
- Los remotos aparecen en la posición del personaje principal (`cameraFocus`),
  con todos sus sprites dentro del contenedor del nivel y pintados en la
  posición de sus cuerpos. Ya no quedan en la coordenada (0, 0).
- Cada remoto se mueve con las teclas de su par (`up`, `right+up`), y el
  usuario confirmó que el control local y el spawn funcionan.
- «Reaparecer jugadores» recrea los remotos sin fugas: el total de cuerpos se
  mantiene en 82.
- Al salir un par de la sala se eliminan sus cuerpos, articulaciones y sprites:
  82 → 67 cuerpos y 87 → 70 articulaciones (Segway Guy: 15 y 17).

## Causa del fallo anterior (personajes en la esquina superior izquierda)

`die()` nativo solo suelta referencias; no destruye cuerpos ni quita sprites.
El spawn fallaba después de `create()` por la comprobación de `userVehicle`, y
los sprites del actor descartado quedaban sin pintar en el origen del nivel.
Además, los cuerpos nuevos tienen la posición interpolada en (0, 0) hasta el
siguiente `InterpolatedStep`, así que el primer `paint()` también los llevaba
al origen.

## Cambios de esta sesión

- La actualización de Steam del 6 de octubre renombró la cola de webpack
  (`Tmuvmbn5d9`); ahora se detecta buscando el array de `window` cuyo `push`
  reemplazó webpack. Los IDs de módulo y los nombres de exportación no
  cambiaron.
- El puente registra qué cuerpos, articulaciones y sprites crea cada remoto
  (envolviendo `CreateBody`, `CreateJoint`, `addChild` y `addChildAt` mientras
  se ejecutan sus fases) y los destruye al salir, al fallar el spawn o al
  reaparecer.
- Los remotos se construyen con los mismos argumentos que
  `Session.setupCharacter`; el `tag` nativo prefija las voces del personaje.
- Tras `create()` se desplazan todos los cuerpos con `SetXForm` hasta la
  posición del personaje principal y se inicializa su interpolación.
- Si el nivel se reinicia (nuevo `m_world`), los remotos se recrean.
- La selección local se lee de los ajustes globales (`characterIndex`) y las
  estadísticas `track*` de los remotos no cuentan para el jugador local.
- `scripts/inspect-native-bundle.mjs` reconoce el nuevo decodificador ofuscado.
- `npm run peer` (`scripts/test-peer.mjs`) simula jugadores en la sala.

## Pendiente de validar en el juego

El usuario observó que las físicas superpuestas en el spawn se «buguean». Se
añadió, sin probarlo aún en el juego:

- Modo fantasma al aparecer: un filtro de contactos de Box2D ignora los
  contactos entre un remoto recién creado y el resto de jugadores hasta que
  ninguno de sus cuerpos se toca; después colisionan con normalidad.
- Grupos de colisión propios por remoto (−1 → −1001 − 100·slot, −6 → −1006…),
  porque todos los jugadores comparten grupos negativos nativos y nunca
  colisionarían entre sí. Varias subclases fijan el grupo −1 en el constructor,
  así que se reasignan tras `create()` con `SetFilterData` y `Refilter`.
- Nombres correctos de personajes en el panel y desenfoque de los botones del
  panel tras pulsarlos (Espacio volvía a pulsar el último botón).

Para probarlo sin reiniciar: «Diagnóstico» → «Recargar código local» y luego
«Reaparecer jugadores». Los cambios del panel requieren reiniciar el juego.

## Notas

- El juego se cierra con código 1 si recibe `--remote-debugging-port`,
  `--remote-debugging-pipe` o `--js-flags`; no se usan.
- Cada equipo simula su propio mundo Box2D. Sin replicación autoritativa,
  las colisiones entre jugadores pueden divergir entre equipos.
