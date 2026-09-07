(() => {
  "use strict";
  const channel = document.currentScript.dataset.channel;
  function anchorFor(event) {
    return event.target instanceof Element
      ? event.target.closest("a[data-marka-url]")
      : null;
  }
  function activate(event, anchor) {
    if (
      !event.isTrusted ||
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.shiftKey
    )
      return;
    parent.postMessage(
      {
        type: "marka:open-external-link",
        channel,
        url: anchor.getAttribute("data-marka-url"),
      },
      "*",
    );
  }
  document.addEventListener(
    "click",
    (event) => {
      const anchor = anchorFor(event);
      if (!anchor) return;
      event.preventDefault();
      if (event.button === 0) activate(event, anchor);
    },
    true,
  );
  document.addEventListener(
    "auxclick",
    (event) => {
      if (anchorFor(event)) event.preventDefault();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter") return;
      const anchor = anchorFor(event);
      if (!anchor) return;
      event.preventDefault();
      if (!event.repeat) activate(event, anchor);
    },
    true,
  );
})();
