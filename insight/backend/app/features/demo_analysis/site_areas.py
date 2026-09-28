from __future__ import annotations

import re


def _area_key(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())


_COMMON_AREAS = {
    "A": {"bombsitea", "abombsite", "asite", "sitea"},
    "B": {"bombsiteb", "bbombsite", "bsite", "siteb"},
}

# Named approach/contest areas are deliberately map-specific. Mid and shared
# connectors are omitted so a kill there is not silently credited to either site.
_MAP_SITE_AREAS: dict[str, dict[str, set[str]]] = {
    "de_ancient": {
        "A": {"amain", "along", "temple", "donut", "asite", "abombsite"},
        "B": {"bmain", "cave", "ruin", "ruins", "belbow", "bsite", "bbombsite", "bplatform"},
    },
    "de_anubis": {
        "A": {"amain", "acanal", "canal", "heaven", "asite", "abombsite", "aelbow"},
        "B": {"bmain", "blong", "bcave", "water", "bsite", "bbombsite", "bconnector"},
    },
    "de_dust2": {
        "A": {"along", "longdoors", "pit", "catwalk", "short", "aramp", "asite", "abombsite", "goose"},
        "B": {"bdoors", "btunnels", "lowertunnels", "uppertunnels", "bsite", "bbombsite"},
    },
    "de_cache": {
        "A": {"amain", "highway", "truck", "squeaky", "quad", "asite", "abombsite"},
        "B": {"bmain", "checkers", "forklift", "vents", "bsite", "bbombsite"},
    },
    "de_inferno": {
        "A": {"along", "pit", "balcony", "arch", "library", "short", "asite", "abombsite"},
        "B": {"banana", "coffins", "dark", "bsite", "bbombsite", "bmain"},
    },
    "de_mirage": {
        "A": {"aramp", "palace", "tetris", "stairs", "ticket", "asite", "abombsite", "ninja"},
        "B": {"bapps", "apps", "market", "van", "bench", "bsite", "bbombsite"},
    },
    "de_nuke": {
        "A": {"main", "amain", "hut", "squeaky", "heaven", "trophy", "mini", "asite", "abombsite", "upper"},
        "B": {"ramp", "secret", "vent", "decon", "bsite", "bbombsite", "lower", "bmain"},
    },
    "de_overpass": {
        "A": {"along", "long", "bathrooms", "toilets", "connector", "asite", "abombsite", "fountain"},
        "B": {"monster", "water", "shortb", "bshort", "bsite", "bbombsite", "heavenb"},
    },
    "de_train": {
        "A": {"amain", "ivy", "z", "asite", "abombsite", "tmain", "popdog"},
        "B": {"bmain", "upperb", "lowerb", "bsite", "bbombsite", "connectorb"},
    },
    "de_vertigo": {
        "A": {"aramp", "ramp", "sandbags", "elevator", "heaven", "asite", "abombsite"},
        "B": {"bstairs", "backofb", "bsite", "bbombsite", "bmain"},
    },
}


def normalize_map_name(value: object) -> str:
    """Return the canonical map token from names or workshop paths."""
    text = str(value or "").replace("\\", "/").strip().casefold()
    leaf = text.rsplit("/", 1)[-1]
    return leaf if leaf.startswith(("de_", "cs_", "ar_")) else text


def site_for_area(map_name: object, place_name: object) -> str | None:
    """Map an engine place name to a site or a map-specific site approach."""
    area = _area_key(place_name)
    if not area:
        return None
    map_key = normalize_map_name(map_name)
    mapped = _MAP_SITE_AREAS.get(map_key, {})
    for site, aliases in mapped.items():
        if area in aliases:
            return site
    for site, aliases in _COMMON_AREAS.items():
        if area in aliases:
            return site
    return None
