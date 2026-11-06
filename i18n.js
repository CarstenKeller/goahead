/* GoAhead – Sprache (Deutsch/Englisch) und Darstellung (System/Hell/Dunkel).
 *
 * Wird im <head> vor allen anderen Skripten geladen, damit Farben und Sprache schon beim ersten Zeichnen stimmen.
 * Liest die Einstellungen direkt aus localStorage ("goahead.settings.v1": lang "de"|"en", theme "system"|"light"|"dark").
 *
 * Übersetzt wird vom deutschen Text aus (Deutsch ist die Ausgangssprache, Schlüssel = deutscher Text):
 *  - T("Text {0} …", wert)  – im Code, für Texte mit Werten (Platzhalter {0}, {1} …)
 *  - Oberflächentexte ohne Werte (Knöpfe, Überschriften, title/aria-label/placeholder) übersetzt bei Englisch
 *    ein MutationObserver automatisch, sobald sie im Dokument erscheinen (genauer Vergleich mit dem Wörterbuch).
 *    Deutsch: kein Observer, nichts wird verändert.
 *  - Fehlt eine Übersetzung, bleibt der deutsche Text stehen (GOAHEAD_I18N.missing sammelt sie für Tests).
 * Sprachwechsel lädt die Seite neu (eine laufende Tour bleibt erhalten).
 */
(function () {
  "use strict";

  var stored = {};
  try { stored = JSON.parse(window.localStorage.getItem("goahead.settings.v1") || "{}") || {}; } catch (e) { stored = {}; }
  var lang = stored.lang === "en" ? "en" : "de";
  var root = document.documentElement;
  root.lang = lang;

  // ---------- Darstellung ----------
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var themeMode = { light: 1, dark: 1 }[stored.theme] ? stored.theme : "system";
  function applyTheme(mode) {
    if (mode) themeMode = mode;
    var dark = themeMode === "dark" || (themeMode === "system" && !!(mq && mq.matches));
    root.setAttribute("data-theme", dark ? "dark" : "light");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#1a281d" : "#2e6b30");
  }
  applyTheme();
  if (mq) {
    var onChange = function () { if (themeMode === "system") applyTheme(); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
  }

  // ---------- Wörterbuch Deutsch → Englisch ----------
  var EN = window.GOAHEAD_I18N_EN || {};
  var missing = {};

  function t(de) {
    var s = de;
    if (lang === "en" && de) {
      if (Object.prototype.hasOwnProperty.call(EN, de)) s = EN[de];
      else missing[de] = true;
    }
    if (arguments.length > 1) {
      var args = arguments;
      s = String(s).replace(/\{(\d)\}/g, function (m, i) {
        var v = args[+i + 1];
        return v == null ? "" : String(v);
      });
    }
    return s;
  }

  // Dezimalzahl als Text: Deutsch mit Komma, Englisch mit Punkt
  function dec(x) { return lang === "en" ? String(x) : String(x).replace(".", ","); }

  // ---------- Automatische Übersetzung der Oberfläche (nur Englisch) ----------
  var ATTRS = ["title", "aria-label", "placeholder"];
  function lookup(text) {
    var k = text.trim();
    if (!k || !Object.prototype.hasOwnProperty.call(EN, k)) return null;
    return text.replace(k, EN[k]);
  }
  function translateAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (v) { var n = lookup(v); if (n != null && n !== v) el.setAttribute(ATTRS[i], n); }
    }
  }
  function translateTree(node) {
    if (node.nodeType === 3) {
      var n = lookup(node.nodeValue);
      if (n != null && n !== node.nodeValue) node.nodeValue = n;
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.nodeName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "PRE" ||
        (node.classList && node.classList.contains("leaflet-tile-pane"))) return;
    if (node.hasAttribute && node.hasAttribute("data-noi18n")) return;   // Nutzerdaten, z. B. Namen
    translateAttrs(node);
    for (var c = node.firstChild; c; c = c.nextSibling) translateTree(c);
  }
  function startObserver() {
    // beobachtet ab <html>: erfasst auch alles, was der Parser danach einfügt, und alle späteren Änderungen
    translateTree(document.documentElement);
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === "childList") {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var a = m.addedNodes[j];
            if (a.parentNode && a.parentNode.closest && a.parentNode.closest("[data-noi18n], pre, textarea")) continue;
            translateTree(a);
          }
        } else if (m.type === "attributes") {
          translateAttrs(m.target);
        } else if (m.type === "characterData") {
          var tn = m.target, nv = lookup(tn.nodeValue);
          if (nv != null && nv !== tn.nodeValue) tn.nodeValue = nv;
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (lang === "en") startObserver();

  window.GOAHEAD_I18N = {
    lang: lang,
    locale: lang === "en" ? "en-GB" : "de-DE",
    t: t,
    dec: dec,
    theme: function () { return themeMode; },
    setTheme: applyTheme,
    missing: missing
  };
})();
