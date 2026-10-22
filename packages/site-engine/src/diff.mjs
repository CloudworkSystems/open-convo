#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertContrast, colorScheme, resolveBrand } from "./contrast.mjs";
import { SiteEngineError } from "./errors.mjs";
import { prepareImages } from "./images.mjs";
import { readFactsFile } from "./read-facts.mjs";
import { validateFacts } from "./schema.mjs";

const USAGE =
  "Usage: node packages/site-engine/src/diff.mjs --old <old.facts.json> --new <new.facts.json> [--json]";

const SEARCH_ONLINE = "Search engines will see an online business, with no address";
const SEARCH_LOCAL = "Search engines will see a local business at this address";

const CONTACT_FIELDS = [
  ["phone", "Phone", "phone"],
  ["email", "Email", "email"],
  ["bookingUrl", "Booking link", "booking link"],
];

const ADDRESS_FIELDS = [
  ["street", "Street"],
  ["city", "City"],
  ["region", "Region"],
  ["postalCode", "Postal code"],
  ["country", "Country"],
];

function change(area, kind, fieldPath, before, after, sentence) {
  return { area, kind, path: fieldPath, before, after, sentence };
}

// Printed sentences stay on one line. JSON keeps the facts values unchanged.
function escapeValue(value) {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else out += char;
  }
  return out;
}

function records(list) {
  return list.map((item, index) => ({ item, index }));
}

// Pair entries that share a key. Identical copies match first, in the order
// they appear, so a pure swap is an order change. Whatever is left pairs by
// position; leftovers are additions or removals.
function pairByKey(oldRecords, newRecords, keyFn, sameFn) {
  const oldGroups = new Map();
  const newGroups = new Map();
  for (const record of oldRecords) {
    const key = keyFn(record);
    const group = oldGroups.get(key);
    if (group) group.push(record);
    else oldGroups.set(key, [record]);
  }
  for (const record of newRecords) {
    const key = keyFn(record);
    const group = newGroups.get(key);
    if (group) group.push(record);
    else newGroups.set(key, [record]);
  }

  const keys = [];
  const seen = new Set();
  for (const key of oldGroups.keys()) {
    keys.push(key);
    seen.add(key);
  }
  for (const key of newGroups.keys()) {
    if (!seen.has(key)) keys.push(key);
  }

  const pairs = [];
  const removed = [];
  const added = [];
  for (const key of keys) {
    const oldList = oldGroups.get(key) ?? [];
    const newList = newGroups.get(key) ?? [];
    const usedOld = new Set();
    const usedNew = new Set();
    for (let oldIndex = 0; oldIndex < oldList.length; oldIndex += 1) {
      for (let newIndex = 0; newIndex < newList.length; newIndex += 1) {
        if (usedNew.has(newIndex)) continue;
        if (!sameFn(oldList[oldIndex], newList[newIndex])) continue;
        pairs.push({ old: oldList[oldIndex], new: newList[newIndex], identical: true });
        usedOld.add(oldIndex);
        usedNew.add(newIndex);
        break;
      }
    }
    const oldLeft = oldList.filter((_, index) => !usedOld.has(index));
    const newLeft = newList.filter((_, index) => !usedNew.has(index));
    const count = Math.min(oldLeft.length, newLeft.length);
    for (let index = 0; index < count; index += 1) {
      pairs.push({ old: oldLeft[index], new: newLeft[index], identical: false });
    }
    removed.push(...oldLeft.slice(count));
    added.push(...newLeft.slice(count));
  }
  return { pairs, removed, added };
}

function orderChanged(pairs) {
  if (pairs.length < 2) return false;
  const inOldOrder = [...pairs].sort((left, right) => left.old.index - right.old.index);
  for (let index = 1; index < inOldOrder.length; index += 1) {
    if (inOldOrder[index].new.index < inOldOrder[index - 1].new.index) return true;
  }
  return false;
}

function diffText(area, label, before, after) {
  if (before === after) return [];
  return [
    change(
      area,
      "changed",
      area,
      before,
      after,
      `${label}: ${escapeValue(before)} becomes ${escapeValue(after)}`,
    ),
  ];
}

function photoRecords(facts, prepared) {
  return (facts.images ?? []).map((item, index) => ({
    item,
    index,
    bytes: prepared[index].bytes,
    alt: item.alt,
    file: item.file,
  }));
}

function photoAlts(list) {
  return list.map((record) => escapeValue(record.alt)).join("; ");
}

function diffPhotos(current, next) {
  const oldList = photoRecords(current.facts, current.images);
  const newList = photoRecords(next.facts, next.images);
  if (oldList.length === 0 && newList.length === 0) return [];
  if (oldList.length === 0) {
    return [
      change(
        "photos",
        "section-added",
        "images",
        null,
        next.facts.images,
        `New Photos section: ${photoAlts(newList)}`,
      ),
    ];
  }
  if (newList.length === 0) {
    return [
      change(
        "photos",
        "section-removed",
        "images",
        current.facts.images,
        null,
        `Photos section removed (it said: ${photoAlts(oldList)})`,
      ),
    ];
  }

  const content = pairByKey(
    oldList,
    newList,
    (record) => record.bytes.toString("base64"),
    (left, right) => left.bytes.equals(right.bytes) && left.alt === right.alt,
  );
  const replaced = pairByKey(
    content.removed,
    content.added,
    (record) => record.file,
    () => false,
  );
  const pairs = [
    ...content.pairs.map((pair) => ({ ...pair, mode: pair.identical ? "same" : "alt" })),
    ...replaced.pairs.map((pair) => ({ ...pair, mode: "replaced" })),
  ];
  const added = replaced.added;
  const removed = replaced.removed;

  const changes = [];
  const events = [
    ...pairs.map((pair) => ({ index: pair.new.index, pair })),
    ...added.map((record) => ({ index: record.index, record })),
  ].sort((left, right) => left.index - right.index);

  for (const event of events) {
    if (event.record) {
      changes.push(
        change(
          "photos",
          "added",
          `images[${event.record.index}]`,
          null,
          event.record.item,
          `New photo: ${escapeValue(event.record.alt)}`,
        ),
      );
      continue;
    }
    const { pair } = event;
    if (pair.mode === "alt") {
      changes.push(
        change(
          "photos",
          "changed",
          `images[${pair.new.index}].alt`,
          pair.old.alt,
          pair.new.alt,
          `Photo description changes: ${escapeValue(pair.old.alt)} becomes ${escapeValue(pair.new.alt)}`,
        ),
      );
    } else if (pair.mode === "replaced") {
      changes.push(
        change(
          "photos",
          "changed",
          `images[${pair.new.index}]`,
          pair.old.item,
          pair.new.item,
          `Photo replaced: ${escapeValue(pair.new.alt)}`,
        ),
      );
    }
  }

  for (const record of [...removed].sort((left, right) => left.index - right.index)) {
    changes.push(
      change(
        "photos",
        "removed",
        `images[${record.index}]`,
        record.item,
        null,
        `Photo removed: ${escapeValue(record.alt)}`,
      ),
    );
  }
  if (orderChanged(pairs)) {
    changes.push(
      change(
        "photos",
        "reordered",
        "images",
        current.facts.images,
        next.facts.images,
        "The order of photos changes",
      ),
    );
  }
  return changes;
}

function serviceSame(left, right) {
  return (
    left.item.name === right.item.name &&
    left.item.description === right.item.description &&
    (left.item.price ?? null) === (right.item.price ?? null)
  );
}

function diffServices(oldFacts, newFacts) {
  const oldList = oldFacts.services;
  const newList = newFacts.services;
  if (!oldList && !newList) return [];
  if (!oldList) {
    return [
      change(
        "services",
        "section-added",
        "services",
        null,
        newList,
        `New Services section: ${newList.map((service) => escapeValue(service.name)).join("; ")}`,
      ),
    ];
  }
  if (!newList) {
    return [
      change(
        "services",
        "section-removed",
        "services",
        oldList,
        null,
        `Services section removed (it said: ${oldList.map((service) => escapeValue(service.name)).join("; ")})`,
      ),
    ];
  }

  const { pairs, removed, added } = pairByKey(
    records(oldList),
    records(newList),
    (record) => record.item.name,
    serviceSame,
  );
  const changes = [];
  const pairedAt = new Map(pairs.map((pair) => [pair.new.index, pair]));
  const addedAt = new Map(added.map((record) => [record.index, record]));
  const indexes = [...pairedAt.keys(), ...addedAt.keys()].sort((left, right) => left - right);

  for (const index of indexes) {
    const created = addedAt.get(index);
    if (created) {
      changes.push(
        change(
          "services",
          "added",
          `services[${index}]`,
          null,
          created.item,
          `New service: ${escapeValue(created.item.name)}`,
        ),
      );
      continue;
    }
    const pair = pairedAt.get(index);
    if (pair.identical) continue;
    const before = pair.old.item;
    const after = pair.new.item;
    if (before.description !== after.description) {
      changes.push(
        change(
          "services",
          "changed",
          `services[${index}].description`,
          before.description,
          after.description,
          `Description of ${escapeValue(after.name)}: ${escapeValue(before.description)} becomes ${escapeValue(after.description)}`,
        ),
      );
    }
    const oldPrice = before.price ?? null;
    const newPrice = after.price ?? null;
    if (oldPrice === newPrice) continue;
    if (oldPrice === null) {
      changes.push(
        change(
          "services",
          "added",
          `services[${index}].price`,
          null,
          newPrice,
          `New price of ${escapeValue(after.name)}: ${escapeValue(newPrice)}`,
        ),
      );
    } else if (newPrice === null) {
      changes.push(
        change(
          "services",
          "removed",
          `services[${index}].price`,
          oldPrice,
          null,
          `Price of ${escapeValue(after.name)} removed`,
        ),
      );
    } else {
      changes.push(
        change(
          "services",
          "changed",
          `services[${index}].price`,
          oldPrice,
          newPrice,
          `Price of ${escapeValue(after.name)}: ${escapeValue(oldPrice)} becomes ${escapeValue(newPrice)}`,
        ),
      );
    }
  }

  for (const record of [...removed].sort((left, right) => left.index - right.index)) {
    changes.push(
      change(
        "services",
        "removed",
        `services[${record.index}]`,
        record.item,
        null,
        `Service removed: ${escapeValue(record.item.name)}`,
      ),
    );
  }
  if (orderChanged(pairs)) {
    changes.push(change("services", "reordered", "services", oldList, newList, "The order of services changes"));
  }
  return changes;
}

function hoursForm(hours) {
  if (hours === undefined) return "none";
  if (hours === "By appointment") return "appointment";
  return "list";
}

function slotText(slot) {
  return `${escapeValue(slot.days)} ${escapeValue(slot.open)}\u2013${escapeValue(slot.close)}`;
}

function hoursSame(left, right) {
  return (
    left.item.days === right.item.days &&
    left.item.open === right.item.open &&
    left.item.close === right.item.close
  );
}

function diffHourLists(oldHours, newHours) {
  const { pairs, removed, added } = pairByKey(
    records(oldHours),
    records(newHours),
    (record) => record.item.days,
    hoursSame,
  );
  const changes = [];
  const pairedAt = new Map(pairs.map((pair) => [pair.new.index, pair]));
  const addedAt = new Map(added.map((record) => [record.index, record]));
  const indexes = [...pairedAt.keys(), ...addedAt.keys()].sort((left, right) => left - right);

  for (const index of indexes) {
    const created = addedAt.get(index);
    if (created) {
      changes.push(
        change(
          "hours",
          "added",
          `hours[${index}]`,
          null,
          created.item,
          `New hours: ${slotText(created.item)}`,
        ),
      );
      continue;
    }
    const pair = pairedAt.get(index);
    if (pair.identical) continue;
    const before = pair.old.item;
    const after = pair.new.item;
    changes.push(
      change(
        "hours",
        "changed",
        `hours[${index}]`,
        before,
        after,
        `Hours on ${escapeValue(after.days)}: ${escapeValue(before.open)}\u2013${escapeValue(before.close)} becomes ${escapeValue(after.open)}\u2013${escapeValue(after.close)}`,
      ),
    );
  }

  for (const record of [...removed].sort((left, right) => left.index - right.index)) {
    changes.push(
      change(
        "hours",
        "removed",
        `hours[${record.index}]`,
        record.item,
        null,
        `No longer open: ${escapeValue(record.item.days)}`,
      ),
    );
  }
  if (orderChanged(pairs)) {
    changes.push(change("hours", "reordered", "hours", oldHours, newHours, "The order of hours changes"));
  }
  return changes;
}

function diffHours(oldFacts, newFacts) {
  const oldHours = oldFacts.hours;
  const newHours = newFacts.hours;
  const oldForm = hoursForm(oldHours);
  const newForm = hoursForm(newHours);
  if (oldForm === newForm && oldForm === "none") return [];
  if (oldForm === newForm && oldForm === "appointment") return [];
  if (oldForm === "none" && newForm === "appointment") {
    return [change("hours", "section-added", "hours", null, newHours, "New Hours section: By appointment")];
  }
  if (oldForm === "appointment" && newForm === "none") {
    return [
      change("hours", "section-removed", "hours", oldHours, null, "Hours section removed (it said: By appointment)"),
    ];
  }
  if (oldForm === "none" && newForm === "list") {
    return [
      change(
        "hours",
        "section-added",
        "hours",
        null,
        newHours,
        `New Hours section: ${newHours.map(slotText).join("; ")}`,
      ),
    ];
  }
  if (oldForm === "list" && newForm === "none") {
    return [
      change(
        "hours",
        "section-removed",
        "hours",
        oldHours,
        null,
        `Hours section removed (it said: ${oldHours.map(slotText).join("; ")})`,
      ),
    ];
  }
  if (oldForm === "list" && newForm === "appointment") {
    return [
      change(
        "hours",
        "changed",
        "hours",
        oldHours,
        newHours,
        `Hours become: By appointment (instead of: ${oldHours.map(slotText).join("; ")})`,
      ),
    ];
  }
  if (oldForm === "appointment" && newForm === "list") {
    return [
      change(
        "hours",
        "changed",
        "hours",
        oldHours,
        newHours,
        `Hours become: ${newHours.map(slotText).join("; ")} (instead of: By appointment)`,
      ),
    ];
  }
  return diffHourLists(oldHours, newHours);
}

function locationForm(location) {
  if (location === undefined) return "none";
  if (location === "Online only") return "online";
  return "address";
}

function addressText(location) {
  return `${escapeValue(location.street)}, ${escapeValue(location.city)}, ${escapeValue(location.region)} ${escapeValue(location.postalCode)}, ${escapeValue(location.country)}`;
}

function diffLocation(oldFacts, newFacts) {
  const oldLocation = oldFacts.location;
  const newLocation = newFacts.location;
  const oldForm = locationForm(oldLocation);
  const newForm = locationForm(newLocation);
  if (oldForm === "address" && newForm === "address") {
    const changes = [];
    for (const [key, label] of ADDRESS_FIELDS) {
      if (oldLocation[key] === newLocation[key]) continue;
      changes.push(
        change(
          "location",
          "changed",
          `location.${key}`,
          oldLocation[key],
          newLocation[key],
          `${label}: ${escapeValue(oldLocation[key])} becomes ${escapeValue(newLocation[key])}`,
        ),
      );
    }
    return changes;
  }
  if (oldForm === newForm) return [];
  if (oldForm === "address" && newForm === "online") {
    const text = addressText(oldLocation);
    return [
      change("location", "changed", "location", oldLocation, newLocation, `Location: ${text} becomes Online only`),
      change("location", "changed", "location", oldLocation, newLocation, SEARCH_ONLINE),
    ];
  }
  if (oldForm === "online" && newForm === "address") {
    const text = addressText(newLocation);
    return [
      change("location", "changed", "location", oldLocation, newLocation, `Location: Online only becomes ${text}`),
      change("location", "changed", "location", oldLocation, newLocation, SEARCH_LOCAL),
    ];
  }
  if (oldForm === "none" && newForm === "online") {
    return [change("location", "section-added", "location", null, newLocation, "New Location section: Online only")];
  }
  if (oldForm === "online" && newForm === "none") {
    return [
      change(
        "location",
        "section-removed",
        "location",
        oldLocation,
        null,
        "Location section removed (it said: Online only)",
      ),
    ];
  }
  if (oldForm === "none" && newForm === "address") {
    const text = addressText(newLocation);
    return [
      change("location", "section-added", "location", null, newLocation, `New Location section: ${text}`),
      change("location", "changed", "location", null, newLocation, SEARCH_LOCAL),
    ];
  }
  const text = addressText(oldLocation);
  return [
    change(
      "location",
      "section-removed",
      "location",
      oldLocation,
      null,
      `Location section removed (it said: ${text})`,
    ),
    change("location", "changed", "location", oldLocation, null, SEARCH_ONLINE),
  ];
}

function contactOn(contact) {
  return Boolean(contact && (contact.phone || contact.email || contact.bookingUrl));
}

function contactEntries(contact) {
  const parts = [];
  if (contact.phone) parts.push(escapeValue(contact.phone));
  if (contact.email) parts.push(escapeValue(contact.email));
  if (contact.bookingUrl) parts.push(escapeValue(contact.bookingUrl));
  return parts.join("; ");
}

function diffContact(oldFacts, newFacts) {
  const oldContact = oldFacts.contact;
  const newContact = newFacts.contact;
  const oldOn = contactOn(oldContact);
  const newOn = contactOn(newContact);
  if (!oldOn && !newOn) return [];
  if (!oldOn) {
    return [
      change(
        "contact",
        "section-added",
        "contact",
        null,
        newContact,
        `New Contact section: ${contactEntries(newContact)}`,
      ),
    ];
  }
  if (!newOn) {
    return [
      change(
        "contact",
        "section-removed",
        "contact",
        oldContact,
        null,
        `Contact section removed (it said: ${contactEntries(oldContact)})`,
      ),
    ];
  }

  const changes = [];
  for (const [key, label, noun] of CONTACT_FIELDS) {
    const before = oldContact[key] ?? null;
    const after = newContact[key] ?? null;
    if (before === after) continue;
    const fieldPath = `contact.${key}`;
    if (before === null) {
      changes.push(change("contact", "added", fieldPath, null, after, `New ${noun}: ${escapeValue(after)}`));
    } else if (after === null) {
      changes.push(
        change("contact", "removed", fieldPath, before, null, `${label} removed: ${escapeValue(before)}`),
      );
    } else {
      changes.push(
        change(
          "contact",
          "changed",
          fieldPath,
          before,
          after,
          `${label}: ${escapeValue(before)} becomes ${escapeValue(after)}`,
        ),
      );
    }
  }
  return changes;
}

function socialEntry(link) {
  return `${escapeValue(link.label)} (${escapeValue(link.url)})`;
}

function socialSame(left, right) {
  return left.item.label === right.item.label && left.item.url === right.item.url;
}

function diffSocial(oldFacts, newFacts) {
  const oldList = oldFacts.social;
  const newList = newFacts.social;
  if (!oldList && !newList) return [];
  if (!oldList) {
    return [
      change(
        "social",
        "section-added",
        "social",
        null,
        newList,
        `New Social section: ${newList.map(socialEntry).join("; ")}`,
      ),
    ];
  }
  if (!newList) {
    return [
      change(
        "social",
        "section-removed",
        "social",
        oldList,
        null,
        `Social section removed (it said: ${oldList.map(socialEntry).join("; ")})`,
      ),
    ];
  }

  const { pairs, removed, added } = pairByKey(
    records(oldList),
    records(newList),
    (record) => record.item.url,
    socialSame,
  );
  const changes = [];
  const pairedAt = new Map(pairs.map((pair) => [pair.new.index, pair]));
  const addedAt = new Map(added.map((record) => [record.index, record]));
  const indexes = [...pairedAt.keys(), ...addedAt.keys()].sort((left, right) => left - right);

  for (const index of indexes) {
    const created = addedAt.get(index);
    if (created) {
      changes.push(
        change(
          "social",
          "added",
          `social[${index}]`,
          null,
          created.item,
          `New social link: ${socialEntry(created.item)}`,
        ),
      );
      continue;
    }
    const pair = pairedAt.get(index);
    if (pair.identical) continue;
    changes.push(
      change(
        "social",
        "changed",
        `social[${index}].label`,
        pair.old.item.label,
        pair.new.item.label,
        `Label of ${escapeValue(pair.new.item.url)}: ${escapeValue(pair.old.item.label)} becomes ${escapeValue(pair.new.item.label)}`,
      ),
    );
  }

  for (const record of [...removed].sort((left, right) => left.index - right.index)) {
    changes.push(
      change(
        "social",
        "removed",
        `social[${record.index}]`,
        record.item,
        null,
        `Social link removed: ${socialEntry(record.item)}`,
      ),
    );
  }
  if (orderChanged(pairs)) {
    changes.push(
      change("social", "reordered", "social", oldList, newList, "The order of social links changes"),
    );
  }
  return changes;
}

function diffColors(oldColors, newColors) {
  const changes = [];
  if (oldColors.background !== newColors.background) {
    changes.push(
      change(
        "colors",
        "changed",
        "brand.background",
        oldColors.background,
        newColors.background,
        `Background color: ${oldColors.background} becomes ${newColors.background}`,
      ),
    );
    const before = colorScheme(oldColors.background);
    const after = colorScheme(newColors.background);
    if (before !== after) {
      changes.push(
        change(
          "colors",
          "changed",
          "colorScheme",
          before,
          after,
          `The page now asks browsers for a ${after} color scheme (was ${before})`,
        ),
      );
    }
  }
  if (oldColors.text !== newColors.text) {
    changes.push(
      change(
        "colors",
        "changed",
        "brand.text",
        oldColors.text,
        newColors.text,
        `Text color: ${oldColors.text} becomes ${newColors.text}`,
      ),
    );
  }
  if (oldColors.accent !== newColors.accent) {
    changes.push(
      change(
        "colors",
        "changed",
        "brand.accent",
        oldColors.accent,
        newColors.accent,
        `Accent color: ${oldColors.accent} becomes ${newColors.accent}`,
      ),
    );
  }
  return changes;
}

function diffSiteUrl(before, after) {
  if (before === after) return [];
  return [
    change(
      "siteUrl",
      "changed",
      "siteUrl",
      before,
      after,
      `Site address: ${escapeValue(before)} becomes ${escapeValue(after)}. The page's canonical link and sitemap change too.`,
    ),
  ];
}

function diffChecked(current, next) {
  return [
    ...diffText("name", "Name", current.facts.name, next.facts.name),
    ...diffText("tagline", "Tagline", current.facts.tagline, next.facts.tagline),
    ...diffText("description", "Description", current.facts.description, next.facts.description),
    ...diffPhotos(current, next),
    ...diffServices(current.facts, next.facts),
    ...diffHours(current.facts, next.facts),
    ...diffLocation(current.facts, next.facts),
    ...diffContact(current.facts, next.facts),
    ...diffSocial(current.facts, next.facts),
    ...diffColors(current.colors, next.colors),
    ...diffSiteUrl(current.facts.siteUrl, next.facts.siteUrl),
  ];
}

async function loadChecked(factsPath) {
  const { factsPath: resolved, facts: parsed } = await readFactsFile(factsPath);
  const facts = validateFacts(parsed);
  const colors = resolveBrand(facts.brand);
  assertContrast(colors);
  const images = await prepareImages(path.dirname(resolved), facts.images ?? []);
  return { facts, colors, images };
}

async function loadSide(factsPath, which) {
  try {
    return await loadChecked(factsPath);
  } catch (error) {
    if (error instanceof SiteEngineError) {
      throw new SiteEngineError(`${error.message}\nRefused the ${which} file.`);
    }
    throw error;
  }
}

export async function diffFacts(oldPath, newPath) {
  const current = await loadSide(oldPath, "current");
  const next = await loadSide(newPath, "new");
  return { schemaVersion: 1, changes: diffChecked(current, next) };
}

function parseArgs(argv) {
  let oldPath = null;
  let newPath = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg !== "--old" && arg !== "--new") throw new SiteEngineError(USAGE);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new SiteEngineError(USAGE);
    if (arg === "--old") oldPath = value;
    else newPath = value;
    index += 1;
  }
  if (!oldPath || !newPath) throw new SiteEngineError(USAGE);
  return { oldPath, newPath, json };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.changes.length === 0) {
    process.stdout.write("Nothing on the site changes.\n");
    return;
  }
  process.stdout.write(`${result.changes.map((item) => item.sentence).join("\n")}\n`);
}

async function main() {
  const { oldPath, newPath, json } = parseArgs(process.argv.slice(2));
  const result = await diffFacts(oldPath, newPath);
  printResult(result, json);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error && error.message ? error.message : "Site Engine failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
