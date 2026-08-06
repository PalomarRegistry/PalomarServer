const CANONICAL_ORIGIN = "https://palomar-registry.org";

/** Redirect the spelling without the hyphen without losing a deep link. */
export default {
  fetch(request) {
    const destination = new URL(request.url);
    destination.protocol = "https:";
    destination.hostname = new URL(CANONICAL_ORIGIN).hostname;
    destination.port = "";

    return new Response(null, {
      status: 308,
      headers: {
        location: destination.href,
        "cache-control": "public, max-age=3600",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  },
};
