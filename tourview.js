/* GoAhead – Tour-Details in einer ziehbaren Leiste und Filter für die Tour-Listen.
 *
 * G.tourView.open({ title, sub, stats: [[Wert, Bezeichnung], …], profile: routeStats|null,
 *                   photos: [Foto, …], onMenu, onClose })  – eine Leiste für geplante und erwanderte Touren
 * G.tourView.close()
 *
 * G.listTools.head(kind, items, opts) → { html, items }  – Kopf einer Liste mit Anzahl, Gesamt-km,
 *   Jahresfilter und Namenssuche (Suchfeld erst auf Knopfdruck). opts: yearOf(item), metersOf(item), nameOf(item)
 * G.listTools.wire(box, kind, rerender)  – Bedienung des Kopfs (nach jedem Neuzeichnen aufrufen)
 */
(function () {
  "use strict";

  var G = window.GOAHEAD;
  if (!G || !G.map) return;
  var esc = G.escapeHtml;

  // ---------- Leiste „Tour“ ----------

  var panel = document.createElement("section");
  panel.id = "tour-panel";
  panel.className = "sheet";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Tour");
  panel.innerHTML =
    '<div class="tour-head sheet-handle">' +
      '<span class="sheet-grip" aria-hidden="true"></span>' +
      '<span class="sheet-titles"><span class="tour-title"></span><span class="tour-sub"></span></span>' +
      '<span class="sheet-head-btns">' +
        '<button type="button" class="icon-btn tour-menu" title="Weitere Aktionen" aria-label="Weitere Aktionen">' + G.icon("more") + "</button>" +
        '<button type="button" class="icon-btn tour-close" title="Schließen" aria-label="Schließen">' + G.icon("close") + "</button>" +
      "</span>" +
    "</div>" +
    '<div class="sheet-body">' +
      '<div class="nav-stats tour-stats"></div>' +
      '<div class="nav-profile-box tour-profile-box" hidden><svg class="pf-svg tour-pf" aria-label="Höhenprofil"></svg></div>' +
      '<div class="tour-photos" hidden></div>' +
    "</div>";
  document.body.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);
  G.makeResizable(panel, panel.querySelector(".tour-head"), "goahead.tourHeight.v1");

  var current = null;

  panel.querySelector(".tour-close").addEventListener("click", function () { close(); });
  panel.querySelector(".tour-menu").addEventListener("click", function () { if (current && current.onMenu) current.onMenu(); });
  panel.querySelector(".tour-photos").addEventListener("click", function (e) {
    var t = e.target.closest("[data-photo]");
    if (t && current && current.photos && G.photos) G.photos.open(current.photos[+t.getAttribute("data-photo")]);
  });

  function open(opts) {
    if (current && current.onClose && current !== opts) { var prev = current; current = null; prev.onClose(); }
    current = opts;
    panel.querySelector(".tour-title").textContent = opts.title || "";
    panel.querySelector(".tour-sub").textContent = opts.sub || "";
    panel.querySelector(".tour-menu").hidden = !opts.onMenu;
    panel.querySelector(".tour-stats").innerHTML = (opts.stats || []).map(function (s) {
      return '<div><span class="nav-val">' + esc(s[0]) + '</span><span class="nav-lbl">' + esc(s[1]) + "</span></div>";
    }).join("");
    var box = panel.querySelector(".tour-profile-box");
    var t = opts.profile;
    box.hidden = !(t && t.hasEle && t.grid && t.grid.length > 1 && G.planner && G.planner.drawProfile);
    panel.hidden = false;
    if (!box.hidden) G.planner.drawProfile(panel.querySelector(".tour-pf"), t, { width: box.clientWidth });
    renderPhotos();
  }

  function renderPhotos() {
    var box = panel.querySelector(".tour-photos");
    var list = (current && current.photos) || [];
    box.hidden = !list.length;
    box.innerHTML = list.map(function (ph, i) {
      return '<button type="button" class="tour-photo" data-photo="' + i + '" title="Foto anzeigen" aria-label="Foto anzeigen">' +
        '<img alt="" src="' + esc(G.photos ? G.photos.url(ph) : "") + '"></button>';
    }).join("");
  }

  function close() {
    var c = current;
    current = null;
    panel.hidden = true;
    if (c && c.onClose) c.onClose();
  }

  // Fotos nachreichen (werden asynchron geladen)
  function setPhotos(opts, photos) {
    if (current !== opts) return;
    current.photos = photos;
    renderPhotos();
  }

  G.tourView = { open: open, close: close, setPhotos: setPhotos, isOpen: function () { return !panel.hidden; } };

  // ---------- Listen: Anzahl, Gesamt-km, Jahr, Suche ----------

  var filters = {};   // kind -> {year, q, search}

  function km(m) { return (m / 1000).toFixed(1).replace(".", ","); }

  function head(kind, items, opts) {
    var f = filters[kind] || (filters[kind] = { year: "", q: "", search: false });
    var years = {};
    items.forEach(function (it) { var y = opts.yearOf(it); if (y) years[y] = true; });
    var ys = Object.keys(years).sort().reverse();
    if (f.year && !years[f.year]) f.year = "";
    var q = f.q.trim().toLowerCase();
    var shown = items.filter(function (it) {
      if (f.year && String(opts.yearOf(it)) !== f.year) return false;
      if (q && String(opts.nameOf(it) || "").toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var total = shown.reduce(function (s, it) { return s + (opts.metersOf(it) || 0); }, 0);
    var html =
      '<div class="list-head">' +
        '<span class="list-sum">' + shown.length + (shown.length === 1 ? " Tour" : " Touren") + " · " + km(total) + " km</span>" +
        '<select class="list-year" aria-label="Jahr" title="Jahr">' +
          '<option value="">Alle Jahre</option>' +
          ys.map(function (y) { return '<option value="' + y + '"' + (f.year === y ? " selected" : "") + ">" + y + "</option>"; }).join("") +
        "</select>" +
        '<button type="button" class="icon-btn list-find' + (f.search || f.q ? " on" : "") + '" title="Nach Namen suchen" aria-label="Nach Namen suchen">' + G.icon("search") + "</button>" +
      "</div>" +
      (f.search || f.q ? '<input type="search" class="list-q" placeholder="Name …" value="' + esc(f.q) + '">' : "");
    return { html: html, items: shown };
  }

  function wire(box, kind, rerender) {
    var f = filters[kind];
    if (!f) return;
    var sel = box.querySelector(".list-year");
    if (sel) sel.addEventListener("change", function () { f.year = sel.value; rerender(); });
    var btn = box.querySelector(".list-find");
    if (btn) btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (f.search || f.q) { f.search = false; f.q = ""; } else { f.search = true; }
      rerender();
      var inp = box.querySelector(".list-q");
      if (inp) inp.focus();
    });
    var inp = box.querySelector(".list-q");
    if (inp) {
      inp.addEventListener("click", function (e) { e.stopPropagation(); });
      inp.addEventListener("input", function () {
        f.q = inp.value;
        var pos = inp.selectionStart;
        rerender();
        var n = box.querySelector(".list-q");
        if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (err) { /* egal */ } }
      });
    }
  }

  G.listTools = { head: head, wire: wire };
})();
