// intel-mac: the Intel build's check of the web engine macOS gives Doklin.
// safari_check.rs injects it into every window, before the page's own
// scripts. macOS 12 ships Safari 15's engine and Safari updates replace it,
// so whether the app's code can run depends on the Safari installed. Plain
// ES5 throughout: it has to run on the engines it turns away.
(function () {
  "use strict";

  // The Safari whose engine has everything below.
  var NEEDED = 17;

  // What the app's code needs from the engine, and the Safari that brought
  // it: lookbehind in regular expressions (16.4; the editor's markdown
  // rules) and URL.canParse (17.0; links in diagrams).
  function engineIsNewEnough() {
    try {
      new RegExp("(?<!a)b");
    } catch (e) {
      return false;
    }
    return typeof URL.canParse === "function";
  }
  if (engineIsNewEnough()) return;

  // The app's own scripts would fail part-way on this engine, so none run:
  // the parser runs a script only after the observer has seen it added, and
  // a module script whose type is no longer "module" is never run.
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var node = added[j];
        if (node.nodeName === "SCRIPT" && node.type === "module") node.type = "text/plain";
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  document.addEventListener("DOMContentLoaded", function () {
    observer.disconnect();
    show();
  });

  function invoke(command) {
    try {
      return window.__TAURI_INTERNALS__.invoke(command);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  var STYLE =
    ".dk-safari{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
    "padding:24px;background:#f5f5f7;color:#1d1d1f;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;" +
    "-webkit-user-select:none;cursor:default}" +
    ".dk-safari-card{max-width:440px;padding:28px 28px 22px;border-radius:12px;background:#fff;" +
    "box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 28px rgba(0,0,0,.08)}" +
    ".dk-safari h1{margin:0 0 10px;font-size:19px;font-weight:600;line-height:1.3}" +
    ".dk-safari p{margin:0 0 10px}" +
    ".dk-safari ol{margin:0 0 10px;padding-left:22px}" +
    ".dk-safari li{margin:0 0 4px}" +
    ".dk-safari-quiet{color:#6e6e73}" +
    ".dk-safari-error{color:#c9302c}" +
    ".dk-safari-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}" +
    ".dk-safari button{font:inherit;font-weight:500;padding:6px 14px;border-radius:7px;border:1px solid rgba(0,0,0,.15);" +
    "background:#fff;color:inherit;cursor:default}" +
    ".dk-safari button.dk-safari-primary{border-color:transparent;background:#0a63e6;color:#fff}" +
    "@media (prefers-color-scheme:dark){" +
    ".dk-safari{background:#000;color:#f5f5f7}" +
    ".dk-safari-card{background:#1c1c1e;box-shadow:0 0 0 1px rgba(255,255,255,.08)}" +
    ".dk-safari-quiet{color:#98989d}" +
    ".dk-safari-error{color:#ff6961}" +
    ".dk-safari button{background:#2c2c2e;border-color:rgba(255,255,255,.12)}" +
    ".dk-safari button.dk-safari-primary{background:#0a63e6}}";

  function show() {
    var style = element("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    // The window's title bar is part of the page: the backdrop moves it.
    var backdrop = element("div", "dk-safari");
    backdrop.setAttribute("data-tauri-drag-region", "");
    backdrop.setAttribute("role", "alertdialog");
    backdrop.setAttribute("aria-labelledby", "dk-safari-title");
    var card = element("div", "dk-safari-card");
    var title = element("h1", "", "Doklin needs Safari " + NEEDED + " or later");
    title.id = "dk-safari-title";
    card.appendChild(title);
    card.appendChild(
      element("p", "", "Doklin shows your documents with Safari's engine, and the one on this Mac is too old to run it.")
    );
    var installed = element("p", "dk-safari-quiet");
    installed.hidden = true;
    card.appendChild(installed);

    var steps = element("div");
    steps.appendChild(element("p", "", "To update Safari:"));
    var list = element("ol");
    list.appendChild(element("li", "", "Click Open Software Update below."));
    list.appendChild(element("li", "", "Click “More info…”, tick the Safari update, and click Install Now."));
    list.appendChild(element("li", "", "When it has finished, quit Doklin and open it again."));
    steps.appendChild(list);
    card.appendChild(steps);

    var problem = element("p", "dk-safari-error");
    problem.hidden = true;
    card.appendChild(problem);

    var actions = element("div", "dk-safari-actions");
    var quit = element("button", "", "Quit Doklin");
    quit.type = "button";
    quit.addEventListener("click", function () {
      invoke("safari_check_quit");
    });
    var update = element("button", "dk-safari-primary", "Open Software Update");
    update.type = "button";
    update.addEventListener("click", function () {
      problem.hidden = true;
      invoke("safari_check_open_update").then(null, function (why) {
        problem.textContent = String(why);
        problem.hidden = false;
      });
    });
    actions.appendChild(quit);
    actions.appendChild(update);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    update.focus();

    invoke("safari_check_version").then(function (version) {
      if (!version) return;
      if (parseInt(version, 10) < NEEDED) {
        installed.textContent = "This Mac has Safari " + version + ".";
        installed.hidden = false;
        return;
      }
      // Safari is new enough, but the engine this app was given is not:
      // updating again would not help.
      installed.textContent =
        "Safari " + version + " is installed, but Doklin still gets the older engine. " +
        "Restart this Mac, then open Doklin again.";
      installed.className = "";
      installed.hidden = false;
      steps.hidden = true;
      actions.removeChild(update);
    });
  }
})();
