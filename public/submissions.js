const button = document.getElementById("start-new-submission");
const form = button?.form;

function setStarting(busy) {
  if (!button) return;
  if (busy) {
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
    button.textContent = "Starting the new submission…";
    return;
  }
  delete button.dataset.busy;
  button.removeAttribute("aria-busy");
  button.textContent = "Start the new submission";
}

form?.addEventListener("submit", () => setStarting(true));

// A back-forward cache restore must not leave the action looking in progress.
window.addEventListener("pageshow", () => setStarting(false));
