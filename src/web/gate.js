// The first script the browser version's page runs, before any of the app
// is asked for. Plain ES5, so the oldest browser that gets here can still
// read it: the app's own script is a module no such browser could parse.
//
// It stops two visitors, and for both the app is never loaded:
//
//   a phone or a tablet   The browser version has no layout for one; Doklin
//                         there is the mobile app. No sign-in is shown, so no
//                         code is ever spent on a screen that cannot use it.
//   an old browser        The editor's markdown rules need lookbehind in a
//                         regular expression (Safari 16.4) and diagram links
//                         need URL.canParse (Safari 17). An old Mac's own
//                         Safari would otherwise fail part-way.
//
// Neither is a security rule: a tablet set to "desktop site" passes as a
// computer, and gets a page laid out for a mouse.
(function () {
  var ua = navigator.userAgent;
  var short = Math.min(screen.width, screen.height);
  // What counts as a phone or a tablet: the browser names itself one; or it
  // is a Mac with more than one touch point (an iPad asking for the desktop
  // site); or the screen's short side is under 600 px. A laptop with a
  // touchscreen is a computer.
  var handheld =
    /iPhone|iPad|iPod|Android/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) ||
    short < 600;
  var old = typeof URL !== "function" || typeof URL.canParse !== "function";
  try {
    new RegExp("(?<=a)b");
  } catch (e) {
    old = true;
  }
  var why = handheld ? "handheld" : old ? "old" : null;
  if (!why) return;
  // The page's own script reads this and loads nothing (main.ts).
  document.documentElement.setAttribute("data-gate", why);
  document.getElementById("gate-" + why).hidden = false;
})();
