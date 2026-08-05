// The access token lives in the URL fragment, which browsers never send to a
// server. It is posted once in exchange for a short-lived cookie, then removed
// from the address bar, so it never appears in a request path or a log.
const token = location.hash.replace(/^#/, "");
const summary = document.getElementById("summary");
const details = document.getElementById("details");
const events = document.getElementById("events");

const LABELS = {
  verifying: "Mechanically verifying your submission.",
  "verification-failed": "Mechanical verification did not pass.",
  "awaiting-review": "Verification passed. Waiting for editorial review.",
  "review-ready": "Your editorial review is ready.",
  published: "Published to the registry.",
  withdrawn: "Withdrawn.",
};

function row(term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value); else dd.textContent = value;
  details.append(dt, dd);
}

function link(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  a.rel = "noreferrer";
  return a;
}

async function establishSession() {
  if (!token) return false;
  const body = new FormData();
  body.set("token", token);
  const response = await fetch("/session", { method: "POST", body, credentials: "same-origin" });
  // Drop the token from the address bar and from history once exchanged.
  history.replaceState(null, "", location.pathname + location.search);
  return response.ok;
}

async function poll() {
  let data;
  try {
    const response = await fetch("/api/submission", { credentials: "same-origin" });
    if (!response.ok) { summary.textContent = "This submission could not be found."; return; }
    data = await response.json();
  } catch { summary.textContent = "Could not reach the server. Retrying."; setTimeout(poll, 8000); return; }

  summary.textContent = LABELS[data.status] ?? data.status;
  details.replaceChildren();
  row("Repository", link(`https://github.com/${data.repository}`, data.repository));
  row("Commit", data.commit);
  row("Submitted", data.created_at ?? "");
  if (data.run?.url) row("Verification run", link(data.run.url, data.run.url.split("/").pop()));

  events.replaceChildren();
  for (const event of data.events ?? []) {
    const li = document.createElement("li");
    li.textContent = `${event.at} — ${event.note}`;
    events.append(li);
  }

  if (data.status === "verifying") setTimeout(poll, 6000);
}

(async () => {
  if (token && !(await establishSession())) {
    summary.textContent = "This submission could not be found.";
    return;
  }
  poll();
})();
