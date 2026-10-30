"""Thirteen architect sketch-edit tasks: a starting scene, the instruction, a task check, a gold answer.

Each check takes (base_scene, after_scene, touched, response) and returns {name: bool}.
The gold answers exist to prove the checker passes a good edit; `NEGATIVES` prove it fails bad ones.
"""

from __future__ import annotations

from sketch_edit_lib import SHAPES
from sketch_edit_lib import bbox
from sketch_edit_lib import by_id
from sketch_edit_lib import centre
from sketch_edit_lib import connected
from sketch_edit_lib import connections
from sketch_edit_lib import find_by_label
from sketch_edit_lib import label_of
from sketch_edit_lib import norm

BLUE, GREEN, ORANGE, VIOLET, YELLOW = "#a5d8ff", "#b2f2bb", "#ffd8a8", "#d0bfff", "#fff3bf"


def S(id, x, y, label, w=160, h=80, type="ellipse", bg=None, **kw):
    e = {"type": type, "id": id, "x": x, "y": y, "width": w, "height": h, "label": {"text": label}}
    if bg:
        e.update(backgroundColor=bg, fillStyle="hachure")
    e.update(kw)
    return e


def T(x, y, text, size=16, id=None):
    e = {"type": "text", "x": x, "y": y, "text": text, "fontSize": size}
    if id:
        e["id"] = id
    return e


def _clip(b, toward):
    """Where the segment from the box centre toward `toward` leaves the box."""
    cx, cy = centre(b)
    dx, dy = toward[0] - cx, toward[1] - cy
    hw, hh = (b[2] - b[0]) / 2, (b[3] - b[1]) / 2
    s = min(hw / abs(dx) if dx else 1e9, hh / abs(dy) if dy else 1e9)
    return cx + dx * s, cy + dy * s


def C(id, a, b, els, type="line", dashed=False, label=None, arrow=False):
    ids = by_id(els)
    ba, bb = bbox(ids[a]), bbox(ids[b])
    p0, p1 = _clip(ba, centre(bb)), _clip(bb, centre(ba))
    e = {
        "type": "arrow" if (arrow or type == "arrow") else type,
        "id": id,
        "x": round(p0[0]),
        "y": round(p0[1]),
        "points": [[0, 0], [round(p1[0] - p0[0]), round(p1[1] - p0[1])]],
        "start": {"id": a},
        "end": {"id": b},
    }
    if e["type"] == "arrow" and not arrow:
        e.update(startArrowhead=None, endArrowhead=None)
    if dashed:
        e["strokeStyle"] = "dashed"
    if label:
        e["label"] = {"text": label}
    return e


def scene(title, *els):
    els = list(els)
    out = []
    for e in els:
        out.append(e(out) if callable(e) else e)
    return {"title": title, "elements": out}


def L(id, a, b, **kw):
    return lambda els: C(id, a, b, els, **kw)


def one(after, label, types=SHAPES):
    found = find_by_label(after["elements"], label, types)
    return found[0] if len(found) == 1 else None


def box_of(after, el):
    return bbox(el, by_id(after["elements"]))


def has_text(after, needle):
    n = norm(needle)
    return [e for e in after["elements"] if n in norm(label_of(e))]


TASKS: list[dict] = []


def task(id, instruction, base):
    def deco(fn):
        TASKS.append({"id": id, "instruction": instruction, "scene": base, "check": fn})
        return fn

    return deco


# 1 ---------------------------------------------------------------- reorder by Erschließung
_t1 = scene(
    "Raumprogramm Kita",
    T(0, -60, "Raumprogramm Kita", 24),
    S("gruppe1", 520, 360, "Gruppenraum 1", bg=GREEN),
    S("eingang", 600, 0, "Eingang", type="rectangle", bg=YELLOW),
    S("flur", 0, 360, "Flur", type="rectangle", bg=YELLOW),
    S("gruppe2", 280, 0, "Gruppenraum 2", bg=GREEN),
    S("garderobe", 0, 160, "Garderobe", bg=ORANGE),
    S("wc", 280, 200, "Kinder-WC", bg=BLUE),
    L("l1", "eingang", "garderobe"),
    L("l2", "garderobe", "flur"),
    L("l3", "flur", "gruppe1"),
    L("l4", "flur", "gruppe2"),
    L("l5", "flur", "wc"),
)


@task(
    "reorder-circulation",
    "Ordne die Blasen nach der Erschließung: links der Eingang, rechts davon die Garderobe, dann der Flur, "
    "und die Räume, die vom Flur erschlossen werden, nah am Flur. Nichts hinzufügen oder löschen.",
    _t1,
)
def _c1(base, after, touched, resp):
    ids = by_id(after["elements"])
    if not all(k in ids for k in ("eingang", "garderobe", "flur", "gruppe1", "gruppe2", "wc")):
        return {"all_kept": False}
    cx = {k: centre(bbox(ids[k]))[0] for k in ids if ids[k]["type"] in SHAPES}
    fc = centre(bbox(ids["flur"]))
    near = all(
        ((centre(bbox(ids[k]))[0] - fc[0]) ** 2 + (centre(bbox(ids[k]))[1] - fc[1]) ** 2) ** 0.5 < 330
        for k in ("gruppe1", "gruppe2", "wc")
    )
    return {
        "all_kept": not touched["removed"] and not touched["added"],
        "sequence_left_to_right": cx["eingang"] < cx["garderobe"] < cx["flur"],
        "rooms_near_flur": near,
    }


# 2 ---------------------------------------------------------------- add Fluchtweg
_t2 = scene(
    "Büroetage 2. OG",
    T(0, -60, "Büroetage 2. OG", 24),
    S("b1", 0, 0, "Büro 1", type="rectangle"),
    S("b2", 220, 0, "Büro 2", type="rectangle"),
    S("b3", 440, 0, "Büro 3", type="rectangle"),
    S("flur", 0, 160, "Flur", w=600, h=80, type="rectangle", bg=YELLOW),
    S("th", 680, 160, "Treppenhaus", type="rectangle", bg=ORANGE),
    S("tk", 0, 320, "Teeküche", type="rectangle"),
    S("wc", 220, 320, "WC", type="rectangle"),
    L("d1", "b1", "flur"),
    L("d2", "b2", "flur"),
    L("d3", "b3", "flur"),
    L("d4", "flur", "th"),
)


@task(
    "add-escape-route",
    "Zeichne den Fluchtweg von Büro 1 über den Flur bis ins Treppenhaus ein, als gestrichelte Pfeile, "
    "und beschrifte ihn mit „Fluchtweg“.",
    _t2,
)
def _c2(base, after, touched, resp):
    ids = by_id(after["elements"])
    new = [ids[i] for i in touched["added"] if i in ids and ids[i]["type"] == "arrow"]
    pairs = {
        frozenset(((a["start"] or {}).get("id"), (a["end"] or {}).get("id")))
        for a in new
        if a.get("start") and a.get("end")
    }
    chain = ({frozenset(("b1", "flur")), frozenset(("flur", "th"))} <= pairs) or frozenset(("b1", "th")) in pairs
    ends_th = any((a.get("end") or {}).get("id") == "th" for a in new)
    return {
        "chain_b1_flur_th": chain,
        "points_to_treppenhaus": ends_th,
        "dashed": bool(new) and all(a.get("strokeStyle") == "dashed" for a in new),
        "labelled": bool(has_text(after, "fluchtweg")),
        "nothing_removed": not touched["removed"],
    }


# 3 ---------------------------------------------------------------- frames per Geschoss
_t3 = scene(
    "Einfamilienhaus, Räume",
    T(0, -60, "Einfamilienhaus, Räume", 24),
    S("diele", 0, 0, "Diele", bg=YELLOW),
    S("schlafen", 220, 0, "Schlafen", bg=BLUE),
    S("wohnen", 440, 0, "Wohnen", bg=GREEN),
    S("kind", 0, 140, "Kind", bg=BLUE),
    S("kueche", 220, 140, "Küche", bg=GREEN),
    S("bad", 440, 140, "Bad", bg=BLUE),
)


@task(
    "frames-per-storey",
    "Fasse die Räume je Geschoss in einen Rahmen: EG mit Diele, Wohnen und Küche; OG mit Schlafen, Kind und Bad. "
    "Die Rahmen dürfen sich nicht überlappen.",
    _t3,
)
def _c3(base, after, touched, resp):
    ids = by_id(after["elements"])
    frames = [e for e in after["elements"] if e["type"] == "frame"]
    eg = [f for f in frames if "eg" in norm(f.get("name")) or "erdgeschoss" in norm(f.get("name"))]
    og = [f for f in frames if "og" in norm(f.get("name")) or "obergeschoss" in norm(f.get("name"))]
    ok_eg = len(eg) == 1 and set(eg[0]["children"]) == {"diele", "wohnen", "kueche"}
    ok_og = len(og) == 1 and set(og[0]["children"]) == {"schlafen", "kind", "bad"}
    sep = False
    if ok_eg and ok_og:
        a, b = bbox(eg[0], ids), bbox(og[0], ids)
        sep = a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1]
    return {"eg_frame_children": ok_eg, "og_frame_children": ok_og, "frames_disjoint": sep}


# 4 ---------------------------------------------------------------- street + access
_t4 = scene(
    "Lageskizze Grundstück",
    T(0, -60, "Lageskizze Grundstück", 24),
    {
        "type": "line",
        "id": "plot",
        "x": 0,
        "y": 0,
        "points": [[0, 0], [600, 0], [640, 420], [-20, 400], [0, 0]],
        "roughness": 2,
    },
    S("haus", 200, 120, "Wohnhaus", w=220, h=140, type="rectangle", bg=ORANGE),
    {"type": "arrow", "id": "north", "x": 720, "y": 120, "points": [[0, 0], [0, -80]]},
    T(712, 130, "N", 20, id="ntext"),
)


@task(
    "street-and-access",
    "Die Lindenstraße liegt an der Südseite des Grundstücks. Beschrifte sie dort und zeichne die Zufahrt "
    "von der Straße zum Wohnhaus als Pfeil.",
    _t4,
)
def _c4(base, after, touched, resp):
    ids = by_id(after["elements"])
    plot = bbox(ids["plot"])
    street = [e for e in has_text(after, "lindenstr") if e["type"] == "text" or e["type"] in SHAPES]
    south = any(centre(bbox(e))[1] > plot[1] + 0.75 * (plot[3] - plot[1]) for e in street)
    arrows = [ids[i] for i in touched["added"] if i in ids and ids[i]["type"] == "arrow"]
    access = [a for a in arrows if (a.get("end") or {}).get("id") == "haus"]
    from_south = any(a["y"] > bbox(ids["haus"])[3] for a in access)
    return {
        "street_labelled": bool(street),
        "street_on_south": south,
        "access_arrow_to_house": bool(access),
        "access_from_south": from_south,
    }


# 5 ---------------------------------------------------------------- list to bubbles
_t5 = scene("Raumprogramm Wohnung", T(0, -60, "Raumprogramm Wohnung", 24, id="title"))


@task(
    "list-to-bubbles",
    "Mach aus dieser Liste ein Raumprogramm als Blasen: Wohnen, Kochen, Essen, Schlafen, Bad, Arbeiten. "
    "Kochen grenzt an Essen, Essen an Wohnen, Schlafen an Bad. Tagbereich und Nachtbereich je in einer Farbe.",
    _t5,
)
def _c5(base, after, touched, resp):
    els = after["elements"]
    want = ["Wohnen", "Kochen", "Essen", "Schlafen", "Bad", "Arbeiten"]
    found = {w: one(after, w) for w in want}
    allp = all(found.values())
    pairs = allp and all(
        connected(els, found[a]["id"], found[b]["id"])
        for a, b in (("Kochen", "Essen"), ("Essen", "Wohnen"), ("Schlafen", "Bad"))
    )
    colours = (
        allp
        and found["Wohnen"].get("backgroundColor")
        == found["Essen"].get("backgroundColor")
        == found["Kochen"].get("backgroundColor")
        and found["Schlafen"].get("backgroundColor") == found["Bad"].get("backgroundColor")
        and found["Schlafen"].get("backgroundColor") != found["Wohnen"].get("backgroundColor")
    )
    return {"six_bubbles": allp, "adjacencies_joined": bool(pairs), "day_night_colours": bool(colours)}


# 6 ---------------------------------------------------------------- Variante B beside A
_t6 = scene(
    "Varianten Erdgeschoss",
    T(0, -100, "Varianten Erdgeschoss", 24),
    S("a_eingang", 0, 0, "Eingang", type="rectangle", bg=ORANGE),
    S("a_kueche", 0, 120, "Küche", type="rectangle", bg=ORANGE),
    S("a_essen", 0, 240, "Essen", type="rectangle", bg=ORANGE),
    S("a_wohnen", 0, 360, "Wohnen", type="rectangle", bg=ORANGE),
    {
        "type": "frame",
        "id": "var_a",
        "name": "Variante A",
        "children": ["a_eingang", "a_kueche", "a_essen", "a_wohnen"],
    },
)


@task(
    "variant-b-beside-a",
    "Lege rechts neben Variante A eine Variante B an: dieselben Räume in derselben Reihenfolge, "
    "nur Küche und Essen getauscht. "
    "Variante B ist die empfohlene.",
    _t6,
)
def _c6(base, after, touched, resp):
    ids = by_id(after["elements"])
    frames = [f for f in after["elements"] if f["type"] == "frame" and "variante b" in norm(f.get("name"))]
    if len(frames) != 1:
        return {"frame_b": False}
    fb = frames[0]
    kids = [ids[c] for c in fb["children"] if c in ids]
    order = [norm(label_of(k)) for k in sorted(kids, key=lambda k: centre(bbox(k))[1]) if k["type"] in SHAPES]
    a = bbox(ids["var_a"], ids)
    b = bbox(fb, ids)
    green = [k for k in kids if k["type"] in SHAPES]
    return {
        "frame_b": True,
        "b_right_of_a": b[0] >= a[2],
        "b_order_swapped": order == ["eingang", "essen", "küche", "wohnen"],
        "a_untouched": not any(
            i in touched["updated"] + touched["removed"]
            for i in ("a_eingang", "a_kueche", "a_essen", "a_wohnen", "var_a")
        ),
        "recommended_marked": bool(has_text(after, "empfohlen"))
        or (len(green) == 4 and all(k.get("backgroundColor") == GREEN for k in green)),
    }


# 7 ---------------------------------------------------------------- mark Fassung changes
_t7 = scene(
    "Grundriss Wohnung, Stand B",
    T(0, -60, "Grundriss Wohnung, Stand B", 24),
    S("flur", 0, 0, "Flur", type="rectangle", bg=YELLOW),
    S("wohnen", 220, 0, "Wohnen", type="rectangle", bg=GREEN),
    S("abst", 0, 140, "Abstellraum", type="rectangle"),
    S("gwc", 220, 140, "Gäste-WC", type="rectangle"),
    S("bad", 440, 140, "Bad", type="rectangle", bg=BLUE),
    L("x1", "flur", "wohnen"),
    L("x2", "flur", "abst"),
    L("x3", "flur", "gwc"),
)


@task(
    "mark-revision-changes",
    "Markiere, was sich gegenüber der letzten Fassung geändert hat: der Abstellraum ist neu, das Gäste-WC entfällt. "
    "Nichts löschen, nur kennzeichnen.",
    _t7,
)
def _c7(base, after, touched, resp):
    ids = by_id(after["elements"])

    def marked(target, word):
        el = ids.get(target)
        if not el:
            return False
        if word in norm(label_of(el)):
            return True
        for s, t, c in connections(after["elements"]):
            other = s if t == target else t if s == target else None
            if (
                other
                and other in ids
                and word in norm(label_of(ids[other]))
                or (target in (s, t) and word in norm(label_of(c)))
            ):
                return True
        b = bbox(el)
        return any(
            word in norm(e.get("text"))
            and min(abs(centre(bbox(e))[0] - centre(b)[0]), 1e9) < 200
            and abs(centre(bbox(e))[1] - centre(b)[1]) < 150
            for e in after["elements"]
            if e["type"] == "text"
        )

    return {
        "nothing_removed": not touched["removed"],
        "gwc_kept": "gwc" in ids,
        "abst_marked_new": marked("abst", "neu"),
        "gwc_marked_dropped": marked("gwc", "entf"),
    }


# 8 ---------------------------------------------------------------- remove duplicates
_t8 = scene(
    "Raumprogramm Praxis",
    T(0, -60, "Raumprogramm Praxis", 24, id="title"),
    S("empfang", 0, 0, "Empfang", bg=YELLOW),
    S("warten", 240, 0, "Warten", bg=YELLOW),
    S("beh1", 0, 160, "Behandlung", bg=BLUE),
    S("labor", 240, 160, "Labor", bg=BLUE),
    S("beh1b", 480, 160, "Behandlung", bg=BLUE),
    S("warten2", 480, 0, "Warten", bg=YELLOW),
    L("c1", "empfang", "warten"),
    L("c2", "empfang", "beh1"),
    L("c3", "beh1b", "labor"),
    T(0, -60, "Raumprogramm Praxis", 24, id="title2"),
)


@task(
    "remove-duplicates",
    "In der Skizze sind Räume und der Titel doppelt. Entferne die Doppelten so, dass jede Verbindung erhalten bleibt.",
    _t8,
)
def _c8(base, after, touched, resp):
    els = after["elements"]
    labels = [norm(label_of(e)) for e in els if e["type"] in SHAPES]
    beh = find_by_label(els, "Behandlung")
    lab = find_by_label(els, "Labor")
    emp = find_by_label(els, "Empfang")
    keep = (
        len(beh) == 1
        and len(lab) == 1
        and len(emp) == 1
        and connected(els, beh[0]["id"], lab[0]["id"])
        and connected(els, emp[0]["id"], beh[0]["id"])
    )
    titles = [e for e in els if e["type"] == "text" and "praxis" in norm(e["text"])]
    return {
        "labels_unique": len(labels) == len(set(labels)) == 4,
        "connections_kept": keep,
        "one_title": len(titles) == 1,
    }


# 9 ---------------------------------------------------------------- the dimension trap
_t9 = scene(
    "Wohnung, Zonen",
    T(0, -60, "Wohnung, Zonen", 24),
    S("wohnen", 0, 0, "Wohnen", w=200, h=110, bg=GREEN),
    S("kueche", 300, 0, "Küche", bg=GREEN),
    S("schlafen", 0, 220, "Schlafen", bg=BLUE),
    L("w1", "wohnen", "kueche"),
)


@task("dimension-trap", "Schreib die Flächen an die Räume: Wohnen 32 m², Küche 12 m², Schlafen 14 m².", _t9)
def _c9(base, after, touched, resp):
    note = norm(resp.get("note", ""))
    return {
        "explains": any(
            w in note for w in ("maßstab", "fläche", "tabelle", "keine maße", "nicht maß", "m²", "dimension")
        )
    }


# 10 ---------------------------------------------------------------- insert between, needs room
_t10 = scene(
    "Raumprogramm Einfamilienhaus, Service",
    T(0, -60, "Service", 24),
    S("kueche", 0, 0, "Küche", bg=GREEN),
    S("garage", 200, 0, "Garage", type="rectangle", bg=ORANGE),
    S("eingang", 100, 180, "Eingang", type="rectangle", bg=YELLOW),
    L("k1", "kueche", "garage"),
    L("k2", "eingang", "kueche"),
    L("k3", "eingang", "garage"),
)


@task(
    "insert-between",
    "Füge einen Hauswirtschaftsraum zwischen Küche und Garage ein, an beide angebunden. "
    "Küche und Garage sollen dann nicht mehr direkt verbunden sein.",
    _t10,
)
def _c10(base, after, touched, resp):
    els = after["elements"]
    hwr = [
        e for e in els if e["type"] in SHAPES and "hauswirtschaft" in norm(label_of(e)) or norm(label_of(e)) == "hwr"
    ]
    if len(hwr) != 1:
        return {"hwr_added": False}
    h = hwr[0]
    ids = by_id(els)
    kx, gx, hx = centre(bbox(ids["kueche"]))[0], centre(bbox(ids["garage"]))[0], centre(bbox(h))[0]
    return {
        "hwr_added": True,
        "between": min(kx, gx) < hx < max(kx, gx),
        "joined_both": connected(els, h["id"], "kueche") and connected(els, h["id"], "garage"),
        "direct_link_gone": not connected(els, "kueche", "garage"),
    }


# 11 ---------------------------------------------------------------- recolour + rename
_t11 = scene(
    "Zonen Obergeschoss",
    T(0, -60, "Zonen Obergeschoss", 24),
    S("schlafen", 0, 0, "Schlafen", bg=GREEN),
    S("kind", 220, 0, "Kind", bg=GREEN),
    S("bad", 440, 0, "Bad", bg=GREEN),
    S("arbeiten", 0, 160, "Arbeiten", bg=GREEN),
    S("galerie", 220, 160, "Galerie", bg=GREEN),
)


@task(
    "recolour-and-rename",
    "Die Nachtzone soll blau (#a5d8ff) sein: Schlafen, Kind und Bad. "
    "Benenne „Kind“ in „Kinderzimmer“ um. Der Rest bleibt.",
    _t11,
)
def _c11(base, after, touched, resp):
    ids = by_id(after["elements"])
    return {
        "night_blue": all(
            ids.get(k, {}).get("backgroundColor", "").lower() == BLUE for k in ("schlafen", "kind", "bad")
        ),
        "rest_green": all(ids.get(k, {}).get("backgroundColor") == GREEN for k in ("arbeiten", "galerie")),
        "renamed": norm(label_of(ids.get("kind", {}))) == "kinderzimmer",
        "no_add_remove": not touched["added"] and not touched["removed"],
    }


# 12 ---------------------------------------------------------------- callout
_t12 = scene(
    "Erdgeschoss, Zonen",
    T(0, -60, "Erdgeschoss, Zonen", 24),
    S("wohnen", 0, 0, "Wohnen", w=200, h=110, bg=GREEN),
    S("terrasse", 0, 180, "Terrasse", w=200, type="rectangle", bg=YELLOW),
    S("kueche", 280, 0, "Küche", bg=GREEN),
    S("hwr", 280, 180, "HWR", bg=ORANGE),
    L("t1", "wohnen", "terrasse"),
    L("t2", "wohnen", "kueche"),
)


@task("callout-note", "Setz eine Notiz an die Terrasse: „Südlage, Abendsonne“.", _t12)
def _c12(base, after, touched, resp):
    ids = by_id(after["elements"])
    notes = [
        ids[i] for i in touched["added"] if i in ids and ids[i]["type"] == "text" and "südlage" in norm(ids[i]["text"])
    ]
    arrows = [
        ids[i]
        for i in touched["added"]
        if i in ids and ids[i]["type"] == "arrow" and (ids[i].get("end") or {}).get("id") == "terrasse"
    ]
    return {
        "note_text": len(notes) == 1,
        "arrow_to_terrasse": bool(arrows),
        "arrow_start_free": all(
            not (a.get("start") or {}).get("id") or (a.get("start") or {}).get("id") in [n.get("id") for n in notes]
            for a in arrows
        ),
    }


# 13 ---------------------------------------------------------------- rewire
_t13 = scene(
    "Wohnung, Erschließung",
    T(0, -60, "Wohnung, Erschließung", 24),
    S("flur", 220, 140, "Flur", type="rectangle", bg=YELLOW),
    S("wohnen", 0, 0, "Wohnen", bg=GREEN),
    S("schlafen", 440, 0, "Schlafen", bg=BLUE),
    S("bad", 440, 280, "Bad", bg=BLUE),
    S("kueche", 0, 280, "Küche", bg=GREEN),
    L("r1", "flur", "wohnen"),
    L("r2", "wohnen", "schlafen"),
    L("r3", "flur", "bad"),
    L("r4", "flur", "kueche"),
)


@task(
    "rewire-connection",
    "Die Verbindung zwischen Wohnen und Schlafen ist falsch; Schlafen wird über den Flur erschlossen. Korrigiere das.",
    _t13,
)
def _c13(base, after, touched, resp):
    els = after["elements"]
    return {
        "wrong_link_gone": not connected(els, "wohnen", "schlafen"),
        "flur_schlafen": connected(els, "flur", "schlafen"),
        "others_kept": all(connected(els, "flur", k) for k in ("wohnen", "bad", "kueche")),
    }
