/* FBFLIX Admin panel — plain browser JS, no external libraries.
 *
 * Security rules enforced here:
 *  - The admin key is sent ONLY as the X-Admin-Key header. It is NEVER put
 *    in a URL, query string, or request body, and NEVER displayed, logged,
 *    or included in any error message.
 *  - The key lives in sessionStorage only (key: fbflix_admin_key), so it is
 *    wiped when the tab closes. It is never written to persistent storage.
 *  - Nothing is fetched and no admin UI is shown before a successful login.
 *  - All catalog / API data is rendered with textContent / createElement
 *    only — HTML-string rendering is never used with data from the server.
 *  - Poster image URLs are only assigned when they start with https://.
 *  - All fetch URLs are https://.
 */
(function () {
  'use strict';

  var API = 'https://api.fbflix.site';
  var STORE_KEY = 'fbflix_admin_key';
  var DAILY_LIMIT = 100000;

  var KEY = '';           // in-memory key; cleared on logout
  var itemsCache = [];    // last loaded catalog items

  function $(id) { return document.getElementById(id); }

  function headers(json) {
    var h = { 'X-Admin-Key': KEY };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function fmt(n) { return (Number(n) || 0).toLocaleString('en-US'); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // Only allow https image URLs from catalog/TMDB data.
  function safeImg(src) {
    var img = document.createElement('img');
    if (typeof src === 'string' && src.indexOf('https://') === 0) img.src = src;
    img.alt = '';
    return img;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ---------- Login gate ---------- */

  function showLogin() {
    $('panel').style.display = 'none';
    $('login').style.display = 'block';
  }

  function showPanel() {
    $('login').style.display = 'none';
    $('panel').style.display = 'block';
  }

  function clearKey() {
    KEY = '';
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* storage unavailable */ }
  }

  // Verify a key against the server. Resolves true on 200, false otherwise.
  // Returns 'rate' on 429 so the caller can show the right message.
  function verifyKey(key) {
    return fetch(API + '/api/items', { headers: { 'X-Admin-Key': key } })
      .then(function (r) {
        if (r.status === 200) return true;
        if (r.status === 429) return 'rate';
        return false;
      })
      .catch(function () { return 'net'; });
  }

  function loginError(msg) { $('login_err').textContent = msg; }

  function doLogin() {
    var key = $('admin_key').value.trim();
    if (!key) { loginError('Enter the admin key.'); return; }
    loginError('');
    $('login_btn').disabled = true;
    verifyKey(key).then(function (res) {
      $('login_btn').disabled = false;
      if (res === true) {
        KEY = key;
        try { sessionStorage.setItem(STORE_KEY, key); } catch (e) { /* storage unavailable */ }
        $('admin_key').value = '';
        showPanel();
        switchTab('catalog');
        loadItems();
      } else if (res === 'rate') {
        loginError('Too many attempts — wait an hour and try again.');
      } else if (res === 'net') {
        loginError('Could not reach the server — check your connection.');
      } else {
        loginError('Wrong key — try again.');
      }
    });
  }

  function logout() {
    clearKey();
    $('admin_key').value = '';
    loginError('');
    showLogin();
  }

  /* ---------- Tabs ---------- */

  var loaded = { usage: false, analytics: false, settings: false };

  function switchTab(name) {
    var tabs = ['catalog', 'usage', 'analytics', 'settings'];
    tabs.forEach(function (t) {
      $('tab-' + t).style.display = (t === name) ? 'block' : 'none';
    });
    var btns = document.querySelectorAll('.tabs button[data-tab]');
    btns.forEach(function (b) {
      if (b.getAttribute('data-tab') === name) b.classList.add('active');
      else b.classList.remove('active');
    });
    if (name === 'usage' && !loaded.usage) { loaded.usage = true; loadUsage(); }
    if (name === 'analytics' && !loaded.analytics) { loaded.analytics = true; loadStats(); }
    if (name === 'settings' && !loaded.settings) { loaded.settings = true; loadAdsSetting(); }
  }

  /* ---------- Settings: ads on/off ---------- */

  function loadAdsSetting() {
    var msg = $('ads_msg');
    fetch(API + '/api/ads')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $('ads_toggle').checked = !!(d && d.enabled);
        if (msg) msg.textContent = d && d.enabled ? 'Ads are ON.' : 'Ads are OFF.';
      })
      .catch(function () {
        if (msg) msg.textContent = 'Could not read the current setting — check your connection.';
      });
  }

  function saveAdsSetting() {
    var on = $('ads_toggle').checked;
    var msg = $('ads_msg');
    if (msg) msg.textContent = 'Saving…';
    fetch(API + '/api/settings', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ads_enabled: on })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (msg) msg.textContent = (d && d.ok) ? (on ? 'Ads are ON — the Vignette will load on the next video page.' : 'Ads are OFF — no ad script will load.') : 'Save failed — try again.';
        if (!(d && d.ok)) $('ads_toggle').checked = !on;
      })
      .catch(function () {
        if (msg) msg.textContent = 'Could not reach the server — try again.';
        $('ads_toggle').checked = !on;
      });
  }

  /* ---------- Catalog: form ---------- */

  function typeChanged() {
    var isSeries = $('f_type').value === 'series';
    $('eps').style.display = isSeries ? 'block' : 'none';
    $('movie_url').style.display = isSeries ? 'none' : 'block';
  }

  function addEp(n, title, url, fbId, season) {
    var d = el('div', 'ep');
    var mk = function (ph, val, cls) {
      var i = document.createElement('input');
      i.placeholder = ph;
      i.value = val || '';
      if (cls) i.className = cls;
      d.appendChild(i);
      return i;
    };
    mk('No.', n, 'no');
    mk('Episode title', title);
    mk('MP4 URL', url);
    mk('FB video ID', fbId);
    mk('Season', season, 'season');
    var x = el('button', 'grey sm', 'x');
    x.type = 'button';
    x.addEventListener('click', function () { d.remove(); });
    d.appendChild(x);
    $('ep_list').appendChild(d);
    return d;
  }

  function getEps() {
    var out = [];
    var rows = document.querySelectorAll('#ep_list .ep');
    rows.forEach(function (r) {
      var i = r.querySelectorAll('input');
      if (i[2].value.trim() || i[3].value.trim()) {
        out.push({
          n: i[0].value,
          title: i[1].value,
          url: i[2].value,
          fb_id: i[3].value,
          season: i[4].value
        });
      }
    });
    return out;
  }

  function isEpAdded(season, n) {
    var rows = document.querySelectorAll('#ep_list .ep');
    for (var i = 0; i < rows.length; i++) {
      var inp = rows[i].querySelectorAll('input');
      if (String(inp[4].value || '') === String(season) &&
          String(inp[0].value) === String(n)) return true;
    }
    return false;
  }

  function readForm() {
    return {
      id: $('f_id').value,
      tmdb_id: $('f_tmdb').value,
      type: $('f_type').value,
      title: $('f_title').value,
      year: $('f_year').value,
      rating: $('f_rating').value,
      overview: $('f_overview').value,
      poster: $('f_poster').value,
      backdrop: $('f_backdrop').value,
      url: $('f_url').value,
      fb_id: $('f_fbid').value,
      episodes: getEps()
    };
  }

  function clearForm() {
    ['f_id', 'f_tmdb', 'f_title', 'f_year', 'f_rating', 'f_overview',
     'f_poster', 'f_backdrop', 'f_url', 'f_fbid'].forEach(function (i) {
      $(i).value = '';
    });
    clear($('ep_list'));
    clear($('tmdb_results'));
    clear($('season_list'));
    clear($('episode_list'));
    $('season_msg').textContent = '';
    $('form_msg').textContent = '';
    $('f_type').value = 'movie';
    typeChanged();
  }

  function saveItem() {
    var b = readForm();
    if (!b.title.trim()) { $('form_msg').textContent = 'Title is required'; return; }
    var method, path, body;
    if (b.id) {
      method = 'PUT';
      path = '/api/items?id=' + encodeURIComponent(b.id);
      body = b; // PUT sends the full item incl. id
    } else {
      method = 'POST';
      path = '/api/items';
      body = {
        tmdb_id: b.tmdb_id, type: b.type, title: b.title, year: b.year,
        rating: b.rating, overview: b.overview, poster: b.poster,
        backdrop: b.backdrop, url: b.url, fb_id: b.fb_id, episodes: b.episodes
      }; // POST sends item fields, no id
    }
    $('form_msg').textContent = 'Saving…';
    fetch(API + path, { method: method, headers: headers(true), body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          $('form_msg').textContent = 'Saved.';
          clearForm();
          loadItems();
        } else {
          $('form_msg').textContent = 'Error: ' + (d.error || 'unknown error');
        }
      })
      .catch(function () { $('form_msg').textContent = 'Could not reach the server.'; });
  }

  /* ---------- Catalog: TMDB ---------- */

  function tmdbSearch() {
    var q = $('f_title').value.trim();
    if (!q) { $('form_msg').textContent = 'Type a title first, then search TMDB.'; return; }
    var type = $('f_type').value === 'series' ? 'tv' : 'movie';
    var box = $('tmdb_results');
    clear(box);
    box.appendChild(el('span', 'muted', 'Searching…'));
    fetch(API + '/api/tmdb/search?type=' + type + '&q=' + encodeURIComponent(q), { headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        clear(box);
        if (d.error) { box.appendChild(el('span', 'muted', d.error)); return; }
        (d.results || []).forEach(function (m) {
          var img = safeImg(m.poster);
          img.title = (m.title || '') + ' (' + (m.year || '') + ')';
          img.addEventListener('click', function () {
            $('f_tmdb').value = m.tmdb_id || '';
            clear($('season_list'));
            clear($('episode_list'));
            $('season_msg').textContent = '';
            $('f_title').value = m.title || '';
            $('f_year').value = m.year || '';
            $('f_rating').value = m.rating || '';
            $('f_overview').value = m.overview || '';
            $('f_poster').value = m.poster || '';
            $('f_backdrop').value = m.backdrop || '';
            $('form_msg').textContent = 'Filled from TMDB: ' + (m.title || '');
            if ($('f_type').value === 'series') loadSeasons();
          });
          box.appendChild(img);
        });
        if (!box.children.length) box.appendChild(el('span', 'muted', 'No results'));
      })
      .catch(function () { clear(box); box.appendChild(el('span', 'muted', 'Could not reach the server.')); });
  }

  function loadSeasons() {
    var tv = $('f_tmdb').value.trim();
    var msg = $('season_msg');
    clear($('episode_list'));
    if (!tv) { msg.textContent = 'Pick the show from TMDB search first (click a poster).'; return; }
    msg.textContent = 'Loading seasons…';
    fetch(API + '/api/tmdb/seasons?tv=' + encodeURIComponent(tv), { headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var box = $('season_list');
        clear(box);
        if (d.error) { msg.textContent = d.error; return; }
        if (!(d.seasons || []).length) { msg.textContent = 'No seasons listed on TMDB for this show.'; return; }
        msg.textContent = '';
        d.seasons.forEach(function (s) {
          var b = el('button', 'grey sm', (s.name || ('Season ' + s.n)) + ' (' + s.count + ' eps)');
          b.type = 'button';
          b.addEventListener('click', function () { loadEpisodes(s.n); });
          box.appendChild(b);
        });
      })
      .catch(function () { msg.textContent = 'Could not reach the server.'; });
  }

  function loadEpisodes(season) {
    var tv = $('f_tmdb').value.trim();
    var box = $('episode_list');
    clear(box);
    box.appendChild(el('span', 'muted', 'Loading episodes…'));
    fetch(API + '/api/tmdb/episodes?tv=' + encodeURIComponent(tv) + '&season=' + encodeURIComponent(season), { headers: headers() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        clear(box);
        if (d.error) { box.appendChild(el('span', 'muted', d.error)); return; }
        if (!(d.episodes || []).length) { box.appendChild(el('span', 'muted', 'No episodes listed for this season.')); return; }
        d.episodes.forEach(function (e) {
          var added = isEpAdded(season, e.n);
          var b = el('button', 'grey sm ep-btn',
            (added ? '✓ ' : '') + 'E' + e.n + ' — ' + (e.title || ('Episode ' + e.n)));
          b.type = 'button';
          b.disabled = added;
          if (!added) {
            b.addEventListener('click', function () {
              addEp(e.n, e.title, '', '', season);
              b.textContent = '✓ ' + b.textContent;
              b.disabled = true;
            });
          }
          box.appendChild(b);
        });
      })
      .catch(function () { clear(box); box.appendChild(el('span', 'muted', 'Could not reach the server.')); });
  }

  /* ---------- Catalog: list ---------- */

  function loadItems() {
    fetch(API + '/api/items', { headers: headers() })
      .then(function (r) {
        if (r.status === 401) { logout(); return null; }
        return r.json();
      })
      .then(function (d) {
        if (!d) return;
        itemsCache = d.items || [];
        renderItems(itemsCache);
      })
      .catch(function () {
        $('items').appendChild(el('p', 'muted', 'Could not load the catalog.'));
      });
  }

  function renderItems(items) {
    $('count').textContent = items.length;
    var box = $('items');
    clear(box);
    items.forEach(function (it) {
      var row = el('div', 'item');
      row.appendChild(safeImg(it.poster));
      var info = el('div', 'info');
      var titleLine = el('div');
      titleLine.appendChild(el('b', null, it.title || '(untitled)'));
      var siBadge = el('span', 'badge ' + (it.overview_si ? 'si' : 'en'),
        it.overview_si ? 'Sinhala' : 'EN only');
      titleLine.appendChild(siBadge);
      info.appendChild(titleLine);
      var meta = it.type + (it.year ? ' · ' + it.year : '') +
        (it.fb_id ? ' · FB' : '') +
        (it.type === 'series' ? ' · ' + (it.episodes || []).length + ' eps' : '');
      var metaLine = el('div', 'muted', meta);
      if (it.fb_id) metaLine.appendChild(el('span', 'badge fb', 'FB'));
      info.appendChild(metaLine);
      row.appendChild(info);
      var e = el('button', 'grey sm', 'Edit');
      e.type = 'button';
      e.addEventListener('click', function () { editItem(it.id); });
      var x = el('button', 'sm', 'Delete');
      x.type = 'button';
      x.addEventListener('click', function () { delItem(it.id); });
      row.appendChild(e);
      row.appendChild(x);
      box.appendChild(row);
    });
    if (!items.length) box.appendChild(el('p', 'muted', 'Catalog is empty.'));
  }

  function editItem(id) {
    var it = null;
    for (var i = 0; i < itemsCache.length; i++) {
      if (itemsCache[i].id === id) { it = itemsCache[i]; break; }
    }
    if (!it) return;
    $('f_id').value = it.id || '';
    $('f_tmdb').value = it.tmdb_id || '';
    $('f_title').value = it.title || '';
    $('f_type').value = it.type || 'movie';
    typeChanged();
    $('f_year').value = it.year || '';
    $('f_rating').value = it.rating || '';
    $('f_overview').value = it.overview || '';
    $('f_poster').value = it.poster || '';
    $('f_backdrop').value = it.backdrop || '';
    $('f_url').value = it.url || '';
    $('f_fbid').value = it.fb_id || '';
    clear($('ep_list'));
    (it.episodes || []).forEach(function (e) {
      addEp(e.n, e.title, e.url, e.fb_id, e.season);
    });
    $('form_msg').textContent = '';
    if (it.tmdb_id && it.type === 'series') loadSeasons();
    window.scrollTo(0, 0);
  }

  function delItem(id) {
    if (!confirm('Remove this title from the catalog?')) return;
    fetch(API + '/api/items?id=' + encodeURIComponent(id), { method: 'DELETE', headers: headers() })
      .then(function () { loadItems(); })
      .catch(function () { $('form_msg').textContent = 'Could not reach the server.'; });
  }

  /* ---------- Usage ---------- */

  function renderUsageCard(bodyId, data, errMsg) {
    var body = $(bodyId);
    clear(body);
    if (errMsg) {
      body.appendChild(el('div', 'errbox', errMsg));
      return;
    }
    var today = data.today || 0;
    var month = data.month || 0;
    var limit = data.dailyLimit || DAILY_LIMIT;
    var pct = Math.min(100, (today / limit) * 100);
    var cls = pct >= 100 ? 'over' : (pct >= 80 ? 'warn' : '');
    var label = pct >= 100 ? 'OVER LIMIT' : (pct >= 80 ? 'HIGH — over 80%' : 'OK');
    body.appendChild(el('div', 'big ' + cls, fmt(today)));
    body.appendChild(el('div', 'label', 'requests today'));
    var barOuter = el('div', 'bar-outer');
    var barInner = el('div', 'bar-inner ' + cls);
    barInner.style.width = Math.max(pct, 1) + '%';
    barOuter.appendChild(barInner);
    body.appendChild(barOuter);
    body.appendChild(el('div', 'pct ' + cls, pct.toFixed(1) + '% of daily free limit — ' + label));
    body.appendChild(el('div', null, '')).style.height = '12px';
    var rowMonth = el('div', 'kv');
    rowMonth.appendChild(el('span', 'k', 'This month'));
    rowMonth.appendChild(el('span', 'v', fmt(month)));
    body.appendChild(rowMonth);
    var rowLimit = el('div', 'kv');
    rowLimit.appendChild(el('span', 'k', 'Daily free limit'));
    rowLimit.appendChild(el('span', 'v', fmt(limit)));
    body.appendChild(rowLimit);
    var scripts = data.byScript || {};
    var entries = Object.keys(scripts).map(function (k) { return [k, scripts[k]]; });
    entries.sort(function (a, b) { return b[1] - a[1]; });
    if (entries.length) {
      var wrap = el('div', 'scripts');
      wrap.appendChild(el('h4', null, 'Requests by worker (this month)'));
      entries.slice(0, 8).forEach(function (p) {
        var r = el('div', 'kv');
        r.appendChild(el('span', 'k', p[0]));
        r.appendChild(el('span', 'v', fmt(p[1])));
        wrap.appendChild(r);
      });
      body.appendChild(wrap);
    }
  }

  function loadUsage() {
    $('main_body').replaceChildren(el('p', 'muted', 'Loading…'));
    $('track_body').replaceChildren(el('p', 'muted', 'Loading…'));
    fetch(API + '/api/usage-all', { headers: headers() })
      .then(function (r) {
        if (r.status === 401) { logout(); return null; }
        return r.json();
      })
      .then(function (d) {
        if (!d) return;
        if (d.main) renderUsageCard('main_body', d.main, d.main.error || null);
        else renderUsageCard('main_body', null, 'No usage data returned.');
        if (d.track) renderUsageCard('track_body', d.track, d.track.error || null);
        else renderUsageCard('track_body', null, 'No usage data returned.');
        $('usage_note').textContent = 'Last updated ' + new Date().toLocaleTimeString() + '.';
      })
      .catch(function () {
        renderUsageCard('main_body', null, 'Could not reach the server.');
        renderUsageCard('track_body', null, 'Could not reach the server.');
      });
  }

  /* ---------- Analytics ---------- */

  function loadStats() {
    $('top_list').replaceChildren(el('p', 'muted', 'Loading…'));
    $('days_wrap').replaceChildren(el('p', 'muted', 'Loading…'));
    $('stats_err').textContent = '';
    fetch(API + '/api/stats-all', { headers: headers() })
      .then(function (r) {
        if (r.status === 401) { logout(); return null; }
        return r.json().then(function (d) { return { status: r.status, d: d }; });
      })
      .then(function (res) {
        if (!res) return;
        var d = res.d || {};
        if (d.error || res.status !== 200) {
          $('stats_err').textContent = d.error || ('Server returned ' + res.status + '.');
          $('top_list').replaceChildren(el('p', 'muted', 'No data.'));
          $('days_wrap').replaceChildren(el('p', 'muted', 'No data.'));
          return;
        }
        var counters = d.counters || {};
        $('stat_installs').textContent = fmt(counters.installs);
        $('stat_opens').textContent = fmt(counters.opens);
        $('stat_plays').textContent = fmt(counters.plays);
        var days = d.days || [];
        var last = days.length ? days[days.length - 1] : null;
        $('stat_dau').textContent = last ? fmt(last.dau) : '—';

        var topBox = $('top_list');
        clear(topBox);
        var top = (d.top || []).slice(0, 10);
        if (!top.length) topBox.appendChild(el('p', 'muted', 'No plays recorded yet.'));
        top.forEach(function (t) {
          var r = el('div', 'kv');
          r.appendChild(el('span', 'k', t.title || t.id || '(unknown)'));
          r.appendChild(el('span', 'v', fmt(t.plays) + ' plays'));
          topBox.appendChild(r);
        });

        var wrap = $('days_wrap');
        clear(wrap);
        var recent = days.slice(-14);
        if (!recent.length) { wrap.appendChild(el('p', 'muted', 'No activity recorded yet.')); return; }
        var table = document.createElement('table');
        var thead = document.createElement('thead');
        var hr = document.createElement('tr');
        ['Date', 'Opens', 'Plays', 'Daily users'].forEach(function (h) {
          hr.appendChild(el('th', null, h));
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        recent.forEach(function (day) {
          var tr = document.createElement('tr');
          tr.appendChild(el('td', null, day.date || ''));
          tr.appendChild(el('td', null, fmt(day.opens)));
          tr.appendChild(el('td', null, fmt(day.plays)));
          tr.appendChild(el('td', null, fmt(day.dau)));
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
      })
      .catch(function () {
        $('stats_err').textContent = 'Could not reach the server.';
        $('top_list').replaceChildren(el('p', 'muted', 'No data.'));
        $('days_wrap').replaceChildren(el('p', 'muted', 'No data.'));
      });
  }

  /* ---------- Wire up ---------- */

  $('login_btn').addEventListener('click', doLogin);
  $('admin_key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin();
  });
  $('logout_btn').addEventListener('click', logout);
  document.querySelectorAll('.tabs button[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });
  $('f_type').addEventListener('change', typeChanged);
  $('tmdb_search_btn').addEventListener('click', tmdbSearch);
  $('seasons_btn').addEventListener('click', loadSeasons);
  $('add_ep_btn').addEventListener('click', function () { addEp('', '', '', '', ''); });
  $('save_btn').addEventListener('click', saveItem);
  $('clear_btn').addEventListener('click', clearForm);
  $('usage_refresh_btn').addEventListener('click', loadUsage);
  $('ads_toggle').addEventListener('change', saveAdsSetting);

  typeChanged();

  /* ---------- Boot: verify any stored key before showing anything ---------- */
  var stored = '';
  try { stored = sessionStorage.getItem(STORE_KEY) || ''; } catch (e) { stored = ''; }
  if (stored) {
    verifyKey(stored).then(function (res) {
      if (res === true) {
        KEY = stored;
        showPanel();
        switchTab('catalog');
        loadItems();
      } else {
        clearKey();
        showLogin();
        if (res === 'rate') loginError('Too many attempts — wait an hour and try again.');
      }
    });
  } else {
    showLogin();
  }
})();
