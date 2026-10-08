# Plan: native Happy Wheels multiplayer

On 2026-10-08 a live three-player room was verified: three native characters
in one level, remote controls, spawn on the local character, and cleanup when a
player leaves. Collisions between players after a ghosted spawn are still
unverified in the game. Details are in PROGRESS.md.

## Goal

Support up to eight players in one room. Each connected player appears in the
active Happy Wheels level as a genuine game character with its matching
vehicle, responds to that player's keys, and shares the game's existing Box2D
world with the local player.

## Design

- A reversible Electron preload provides the in-game room panel and connects
  to the relay over WebSocket.
- The relay sends room membership, selected character, and key-state changes.
- Each game client creates remote actors with the installed game's own
  character classes, sprite assets, vehicle controllers, and active session.
- The primary actor's existing update phases also advance each remote actor.
  The level keeps one physics-world step per tick; each actor handles its own
  contacts and joints.
- Every participant must open the same level. Each installation simulates its
  own copy of Box2D while receiving the same key states; the relay does not
  currently send authoritative ragdoll snapshots, so collisions can diverge
  between installations under latency or different frame timing.

## Milestones

1. Keep the installed app archive recoverable and inject the overlay through a
   temporary preload.
2. Construct remote player characters and their correct vehicles through the
   game's native classes and asset wrappers.
3. Place them beside the local character and integrate their controls and
   physics phases without adding another world step.
4. Relay join, leave, avatar, and keyboard state for up to eight players.
5. Verify a live three-player room by joining with two network peers and
   checking that all three native actors appear in the same running level.
6. Document setup, practical limitations, and archive restoration.

## Acceptance

- A single level visibly renders the local character and at least two remote
  players using game assets and vehicles, with no screen-space substitute.
- Remote controls operate the native vehicle controllers.
- Remote actors respond to gravity, level collision, and the other actors in
  the same Box2D world.
- Leaving the room removes that actor; closing the game restores the original
  app archive.
- Validation is manual in the installed game. Do not add or run automated
  test suites.
