const enabledInput = document.getElementById("enabled");
const volumeInput = document.getElementById("volume");
const volumeNumber = document.getElementById("volume-number");
const error = document.getElementById("error");

function showError() {
  error.hidden = false;
  error.textContent = "Unable to save settings.";
}

browser.storage.local.get({ enabled: true, volume: 0.65 })
  .then(({ enabled, volume }) => {
    enabledInput.checked = Boolean(enabled);
    const level = Number(volume);
    volumeInput.value = String(Math.round(Math.max(0, Math.min(1,
      Number.isFinite(level) ? level : 0.65)) * 100));
    volumeNumber.textContent = `${volumeInput.value}%`;
  })
  .catch(showError);

enabledInput.addEventListener("change", () => {
  browser.storage.local.set({ enabled: enabledInput.checked }).catch(showError);
});

volumeInput.addEventListener("input", () => {
  volumeNumber.textContent = `${volumeInput.value}%`;
  browser.storage.local.set({ volume: Number(volumeInput.value) / 100 }).catch(showError);
});
