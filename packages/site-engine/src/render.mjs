import { colorScheme } from "./contrast.mjs";
import { escapeAttr, escapeText, jsonForScript } from "./escape.mjs";

function paragraphs(value) {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return normalized
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split("\n").map((line) => escapeText(line)).join("<br>\n")}</p>`)
    .join("\n");
}

function oneLine(value) {
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function telHref(phone) {
  const compact = phone.replace(/[^\d+]/g, "");
  return `tel:${compact}`;
}

export function buildJsonLd(facts) {
  const location = facts.location;
  const street = location && typeof location === "object";
  const data = {
    "@context": "https://schema.org",
    "@type": street ? "LocalBusiness" : "Organization",
    name: facts.name,
    description: facts.description,
    url: facts.siteUrl,
    slogan: facts.tagline,
  };
  if (street) {
    data.address = {
      "@type": "PostalAddress",
      streetAddress: location.street,
      addressLocality: location.city,
      addressRegion: location.region,
      postalCode: location.postalCode,
      addressCountry: location.country,
    };
  }
  if (facts.contact?.phone) data.telephone = facts.contact.phone;
  if (facts.contact?.email) data.email = facts.contact.email;
  if (facts.hours === "By appointment") {
    data.openingHours = "By appointment";
  } else if (Array.isArray(facts.hours)) {
    data.openingHoursSpecification = facts.hours.map((slot) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: slot.days,
      opens: slot.open,
      closes: slot.close,
    }));
  }
  if (Array.isArray(facts.services)) {
    data.hasOfferCatalog = {
      "@type": "OfferCatalog",
      itemListElement: facts.services.map((service) => {
        const offer = {
          "@type": "Offer",
          name: service.name,
          description: service.description,
        };
        if (service.price) offer.price = service.price;
        return offer;
      }),
    };
  }
  if (Array.isArray(facts.social) && facts.social.length > 0) {
    data.sameAs = facts.social.map((item) => item.url);
  }
  return data;
}

function section(title, body) {
  return `<section>\n<h2>${escapeText(title)}</h2>\n${body}\n</section>`;
}

export function renderPage(facts, images, colors) {
  const scheme = colorScheme(colors.background);
  const title = `${oneLine(facts.name)} — ${oneLine(facts.tagline)}`;
  const description = oneLine(facts.description);
  const jsonLd = buildJsonLd(facts);
  const parts = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(title)}</title>`,
    `<meta name="description" content="${escapeAttr(description)}">`,
    `<meta name="color-scheme" content="${scheme}">`,
    `<meta name="theme-color" content="${colors.background}">`,
    '<meta name="robots" content="index, follow">',
    '<meta name="referrer" content="no-referrer">',
    `<link rel="canonical" href="${escapeAttr(facts.siteUrl)}">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta property="og:url" content="${escapeAttr(facts.siteUrl)}">`,
    '<meta property="og:type" content="website">',
    '<link rel="stylesheet" href="site.css">',
    '<script type="application/ld+json">',
    jsonForScript(jsonLd),
    "</script>",
    "</head>",
    "<body>",
    '<a class="skip" href="#content">Skip to content</a>',
    "<header>",
    `<h1>${escapeText(facts.name)}</h1>`,
    `<p class="tagline">${escapeText(facts.tagline)}</p>`,
    "</header>",
    '<main id="content">',
    section("About", paragraphs(facts.description)),
  ];

  if (images.length > 0) {
    const figures = images
      .map(
        (image) =>
          `<figure>\n<img src="${escapeAttr(image.src)}" alt="${escapeAttr(image.alt)}">\n</figure>`,
      )
      .join("\n");
    parts.push(section("Photos", figures));
  }

  if (Array.isArray(facts.services)) {
    const items = facts.services
      .map((service) => {
        const price = service.price ? ` <span class="price">${escapeText(service.price)}</span>` : "";
        return `<li>\n<strong>${escapeText(service.name)}</strong>${price}\n${paragraphs(service.description)}\n</li>`;
      })
      .join("\n");
    parts.push(section("Services", `<ul>\n${items}\n</ul>`));
  }

  if (facts.hours === "By appointment") {
    parts.push(section("Hours", "<p>By appointment</p>"));
  } else if (Array.isArray(facts.hours)) {
    const items = facts.hours
      .map(
        (slot) =>
          `<li>${escapeText(slot.days)}: ${escapeText(slot.open)}–${escapeText(slot.close)}</li>`,
      )
      .join("\n");
    parts.push(section("Hours", `<ul>\n${items}\n</ul>`));
  }

  if (facts.location === "Online only") {
    parts.push(section("Location", "<p>Online only</p>"));
  } else if (facts.location && typeof facts.location === "object") {
    const place = facts.location;
    const body = [
      `<p>${escapeText(place.street)}<br>`,
      `${escapeText(place.city)}, ${escapeText(place.region)} ${escapeText(place.postalCode)}<br>`,
      `${escapeText(place.country)}</p>`,
    ].join("\n");
    parts.push(section("Location", body));
  }

  if (facts.contact && (facts.contact.phone || facts.contact.email || facts.contact.bookingUrl)) {
    const links = [];
    if (facts.contact.phone) {
      links.push(
        `<a href="${escapeAttr(telHref(facts.contact.phone))}">${escapeText(facts.contact.phone)}</a>`,
      );
    }
    if (facts.contact.email) {
      links.push(
        `<a href="${escapeAttr(`mailto:${facts.contact.email}`)}">${escapeText(facts.contact.email)}</a>`,
      );
    }
    if (facts.contact.bookingUrl) {
      links.push(
        `<a href="${escapeAttr(facts.contact.bookingUrl)}" rel="noopener noreferrer">${escapeText("Book a visit")}</a>`,
      );
    }
    parts.push(section("Contact", `<p class="contact">\n${links.join("\n")}\n</p>`));
  }

  if (Array.isArray(facts.social) && facts.social.length > 0) {
    const items = facts.social
      .map(
        (item) =>
          `<li><a href="${escapeAttr(item.url)}" rel="noopener noreferrer">${escapeText(item.label)}</a></li>`,
      )
      .join("\n");
    parts.push(section("Social", `<ul class="social">\n${items}\n</ul>`));
  }

  parts.push("</main>", "<footer>", `<p>${escapeText(facts.name)}</p>`, "</footer>", "</body>", "</html>", "");
  return {
    html: parts.join("\n"),
    css: renderCss(colors, scheme),
    sitemap: renderSitemap(facts.siteUrl),
    robots: renderRobots(),
    jsonLd,
  };
}

export function renderCss(colors, scheme) {
  return `:root {
  color-scheme: ${scheme};
  --bg: ${colors.background};
  --text: ${colors.text};
  --accent: ${colors.accent};
}
* { box-sizing: border-box; }
html { font-size: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Atkinson Hyperlegible Next", Georgia, "Iowan Old Style", Palatino, "Palatino Linotype", serif;
  font-size: 1.125rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.skip {
  position: absolute;
  left: 0.75rem;
  top: 0.75rem;
  transform: translateY(-200%);
  background: var(--bg);
  color: var(--accent);
  padding: 0.4rem 0.6rem;
}
.skip:focus { transform: none; }
header, main, footer {
  width: min(40rem, calc(100% - 2rem));
  margin-inline: auto;
}
header { padding-top: 2.5rem; }
main { padding-bottom: 2rem; }
footer { padding-bottom: 3rem; }
h1 {
  margin: 0 0 0.35rem;
  font-size: clamp(2rem, 6vw, 3.25rem);
  line-height: 1.15;
  font-weight: 600;
}
h2 {
  margin: 2rem 0 0.6rem;
  font-size: 1.35rem;
  line-height: 1.25;
  font-weight: 600;
}
p, li { margin: 0.4rem 0; }
.tagline { margin: 0; font-size: 1.25rem; }
a { color: var(--accent); text-underline-offset: 0.15em; }
a:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
img { max-width: 100%; height: auto; display: block; }
figure { margin: 1rem 0; }
ul { padding-left: 1.25rem; }
.price { white-space: nowrap; }
.contact a { display: inline-block; margin: 0.35rem 1rem 0.35rem 0; }
@media (max-width: 30rem) {
  header, main, footer { width: min(40rem, calc(100% - 1.5rem)); }
}
`;
}

export function renderSitemap(siteUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapeText(siteUrl)}</loc>
  </url>
</urlset>
`;
}

export function renderRobots() {
  return `User-agent: *
Allow: /

# sitemap.xml is the file beside this one.
`;
}
