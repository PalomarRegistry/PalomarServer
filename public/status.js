// The access token lives in the URL fragment, which is never sent to a server.
// It is read here and passed explicitly to the API.
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

async function poll() {
  if (!token) { summary.textContent = "This link is missing its access token."; return; }
  let data;
  try {
    const response = await fetch(`/api/submission?token=${encodeURIComponent(token)}`);
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

poll();
