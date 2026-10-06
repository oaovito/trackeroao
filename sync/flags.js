'use strict';
/*
 * flags.js - read Sekiro event flags out of a save slot.
 *
 * A flag id decomposes the same way the game decomposes it (this is the
 * FromSoftware scheme, cross-checked against SoulSplitter's decompilation of
 * Sekiro's GetEventFlag and the from-rs event-flag crate):
 *
 *     zone = (id / 1000) % 10
 *     word = (id % 1000) / 32
 *     bit  = 31 - ((id % 1000) % 32)     <- flag ids are little-endian here
 *
 * and the address inside the common block (region 0 / area 0 / group 0) is
 *
 *     base + zone * zoneStride + word * 4
 *
 * `base` is verified on every read against the boss Memories in the item
 * table; on mismatch, a matching base is searched for.
 */

function decompose(id) {
  return {
    id,
    zone: Math.floor(id / 1000) % 10,
    word: Math.floor((id % 1000) / 32),
    bit: 31 - ((id % 1000) % 32),
  };
}

function flagOffset(cfg, id) {
  const d = decompose(id);
  return cfg.base + d.zone * cfg.zoneStride + d.word * 4;
}

/** Read one flag at a given base. Returns null when out of bounds. */
function readAt(payload, cfg, base, id) {
  const d = decompose(id);
  const off = base + d.zone * cfg.zoneStride + d.word * 4;
  if (off < 0 || off + 4 > payload.length) return null;
  return ((payload.readUInt32LE(off) >>> d.bit) & 1) === 1;
}

function read(payload, cfg, id) {
  return readAt(payload, cfg, cfg.base, id);
}

/**
 * Validates the configured base and searches for another if it fails.
 * `expected` maps flag id -> boolean, from the boss Memories in the item table.
 *
 * Returns { base, how, checked } where `how` is 'configured', 'recalibrated'
 * or 'unverified' (not enough reference data).
 */
function calibrate(payload, cfg, expected) {
  const ids = Object.keys(expected).map(Number);
  if (!ids.length) return { base: cfg.base, how: 'unverified', checked: 0 };

  const agrees = (base) =>
    ids.every((id) => {
      const v = readAt(payload, cfg, base, id);
      return v !== null && v === expected[id];
    });

  if (agrees(cfg.base)) return { base: cfg.base, how: 'configured', checked: ids.length };

  // Scan 4-byte-aligned bases for one matching every known flag; accept only
  // an unambiguous result.
  const found = [];
  for (let base = 0; base + cfg.zoneStride * cfg.zoneCount <= payload.length; base += 4) {
    if (agrees(base)) {
      found.push(base);
      if (found.length > 1) break;
    }
  }
  if (found.length === 1) return { base: found[0], how: 'recalibrated', checked: ids.length };
  return { base: cfg.base, how: 'failed', checked: ids.length, candidates: found.length };
}

module.exports = { decompose, flagOffset, read, readAt, calibrate };
