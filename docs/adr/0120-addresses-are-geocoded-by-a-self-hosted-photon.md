---
status: proposed
date: 2026-10-20
decision-makers:
consulted:
informed:
---

# Addresses are geocoded by a Photon in the cluster, over the Austrian OSM extract

## Context and Problem Statement

Step 1 of the project setup (Notion ticket 26,
[`project-setup-five-steps.md`](../design/project-setup-five-steps.md)) takes
the project's address with autocomplete. Land, Bundesland and Gemeinde come
from the chosen hit. The UI side is built: `GET /api/geocode` behind a Photon
adapter (`frontends/ui/src/lib/geocoding/photon.ts`), switched on by
`GRID_GEOCODER_URL`. No deployment sets that variable, so production has no
autocomplete. The dialog falls back to a plain text field, and the Bundesland
is left for the documents to supply or the review to ask.

The address of a planned building is client data. The search runs on every
keystroke, so whatever host answers it sees each address an office is about to
work on, often before the project is public. The design notes already say
production should self-host instead of using the public komoot instance
([`agentic-project-intake.md`](../design/agentic-project-intake.md), geocoder
row). This record picks the provider and how it runs.

## Decision Drivers

* **Privacy.** A typed address must not leave our cluster in the Vienna data
  centre.
* **Austrian accuracy.** House-number hits, the Bundesland as the intake token,
  and the politische Gemeinde rather than the Ortschaft.
* **Autocomplete.** Prefix and typo tolerance at keystroke latency. A geocoder
  that resolves complete addresses only is the wrong tool.
* **Buy, don't build** (AGENTS.md). Search ranking is someone else's domain.
* **Ops effort** for a team with no dedicated operator: one workload, no
  pipeline, refreshable without a person.
* **Fit** with the adapter already built and tested against Photon's response.

## Considered Options

1. Self-hosted **Photon** over GraphHopper's weekly Austria extract
2. **BEV Adressregister** open data (CC BY 4.0), served by an index we build
3. **BEV Adress-Suchservice**, the BEV's paid lookup API
4. Self-hosted **Nominatim**
5. Self-hosted **Pelias**
6. The public **photon.komoot.io** instance, or a commercial API (Google, HERE, Mapbox)

## Decision Outcome

Chosen option: 1, a self-hosted Photon. It is the only option that meets all
four constraints: the query stays in the cluster, it was built for
autocomplete, it is one JVM process with a ready-made Austrian index, and the
adapter, specs and fixtures already speak its API. The fixtures were captured
from photon.komoot.io, which runs Photon 1.3.0 (its `/status` on 2026-10-20),
the same version we pin.

How it runs (`deploy/pulumi/src/data/geocoder.ts`):

* A `geocoder` StatefulSet of one with a 10Gi RWO volume. It runs two official
  images pinned by digest: `eclipse-temurin` 21 JRE for Photon and `alpine` for
  an init container. Upstream publishes no Photon image, and community images
  pull the index from third-party mirrors by default.
* The init container fetches the Photon 1.3.0 release jar and checks it against
  a pinned sha256. It fetches `photon-db-austria-1.0-latest.tar.bz2` (966 MB,
  rebuilt weekly) and checks it against the md5 published beside it. It then
  unpacks the index next to the live one and swaps it in with two renames. A
  failed refresh keeps serving the old index.
* NetworkPolicy `geocoder-frontend-only`: only the frontend gets in; only DNS
  and HTTPS get out (the init container's downloads).
* `GRID_GEOCODER_URL=http://geocoder:2322` on the frontend, set exactly when
  `grid-oib:geocoderEnabled` is true. The flag is off by default: this record
  prepares the deployment, and a person switches it on per stack.

### Consequences

* Good, because no address leaves the cluster. The only outbound traffic is
  the index and jar download, which carries no query.
* Good, because OSM's Austrian house numbers largely come from the BEV
  register itself (OSM has held the BEV's permission to use it since
  2017-03-15), so option 1 already carries most of option 2's data.
* Good, because the hierarchy Photon returns is what the adapter needs. On
  2026-10-20, `Hauptstraße 100 Kritzendorf` answered `city: Klosterneuburg`
  (the Gemeinde), `district: Kritzendorf` (the Ortschaft) and
  `state: Niederösterreich`.
* Good, because a second country is a second extract plus the filter and the
  state mapping the adapter already describes. Nothing about the deployment
  changes.
* Bad, because it is one more stateful workload: about 1.5 GiB of memory
  requested, 3 GiB at the limit, and a 10Gi volume. These sizes are estimates.
  Upstream documents planet sizing only (64 GB RAM), so measure them on the
  first deploy.
* Bad, because the index is only as fresh as the last pod start. A start
  refreshes an index older than `geocoderIndexMaxAgeDays` (30), but nothing
  restarts the pod on a clock. A brand-new address can be missing for weeks,
  and the plain-text fallback covers that case.
* Bad, because the first start depends on two external hosts,
  `download1.graphhopper.com` and GitHub's release CDN. If either is down, the
  pod waits in Init and the dialog keeps the plain text field until the next
  attempt.
* Bad, because OSM is not authoritative. A Gemeinde merger or a street rename
  reaches OSM later than it reaches the BEV, and a Gemeinde boundary that OSM
  has wrong gives a wrong Gemeinde. The review step shows what was derived, and
  a person can correct it.

### Confirmation

* `deploy/pulumi/src/data/geocoder.spec.ts` checks:
  * the digest pins and the jar's version and sha256;
  * the Photon flags, probes and volume;
  * that only the frontend gets the URL, and that `bff-jobs` does not;
  * the NetworkPolicy's single caller and its DNS and 443 egress;
  * the init script itself, run under `sh` against a local server: first
    fetch, freshness, stale replacement, a failed checksum keeping the old
    index, and a refused jar.
* `index.spec.ts` holds the default off.
* `frontends/ui/src/lib/geocoding/photon.spec.ts` holds the parser to Photon
  1.x responses.
* Nothing yet checks that a running stack has the search on. Once a stack
  enables it, the frontend's `/api/geocode` answering `enabled: true` is the
  check to add to the deploy smoke test.

## Pros and Cons of the Options

### 1. Self-hosted Photon

* Good, because it is Apache-2.0 and built for search-as-you-type, with
  `bbox`, `lang` and `layer` filters. It also does reverse geocoding.
* Good, because GraphHopper publishes a ready Austria index every week
  ([downloads](https://download1.graphhopper.com/public/europe/austria/)): 966 MB
  for 1.x on 2026-10-13, plus a 334 MB JSON dump for a custom build.
* Neutral, because it needs Java 21 since 1.0, and a database built for one
  major version does not open in another
  ([releases](https://github.com/komoot/photon/releases)). Bumping the jar's
  major means moving the index URL too.
* Bad, because it has no official container image, so we run the jar on a JRE
  image and fetch it ourselves.

### 2. BEV Adressregister open data, our own index

* Good, because it is the authoritative register, kept by the Gemeinden and
  published by the BEV. Each address has a coordinate and a Gemeindekennziffer
  whose first digit is the Bundesland, so the Gemeinde is exact rather than
  inferred.
* Good, because the relational tables ("Adresse Relationale Tabellen",
  Stichtagsdaten) are a free download under CC BY 4.0
  ([BEV free products](https://bev.gv.at/Services/Downloads/Produktbezogene-Downloads/Unentgeltliche-Produkte/Adressregister.html)),
  and could live in our own Postgres.
* Bad, because it is a file of addresses, not a search engine. Autocomplete
  over it means writing the ingest of a dated zip, the transformation of
  per-address coordinate systems to WGS84, and prefix and typo ranking. That
  is the library we should be buying.
* Bad, because it holds addresses only: no places, Ortschaften or POIs that a
  person may type instead.
* Bad, because it is published as dated snapshots rather than as a feed.
* Revisit when the Gemeinde from OSM proves wrong often enough to matter. The
  register would then join as a lookup that corrects the Gemeinde of a hit
  Photon found (by coordinate or by address code), not as a second search.
  Photon 1.x can also import custom JSON documents, which is the other way in.

### 3. BEV Adress-Suchservice

* Good, because it is authoritative and updated daily.
* Bad, because every typed address goes to a third party, even if that party
  is an Austrian authority. That is the property this record exists to avoid.
* Bad, because it is paid (€480 a year per application for external use, plus
  registration and a client certificate), and the
  [service page](https://bev.gv.at/Services/Geoinformationsdienste/Services/BEV-Adresssuch-Service.html)
  describes coordinate lookup for an address, not autocomplete.

### 4. Self-hosted Nominatim

* Good, because it is the OSM reference geocoder, on PostgreSQL, with
  continuous updates.
* Bad, because its search resolves complete queries and is not built for
  search-as-you-type, which is why Photon exists next to it.
* Bad, because it needs an import of its own (osm2pgsql plus a dedicated
  database) and its own update process: more moving parts than a download.

### 5. Self-hosted Pelias

* Good, because it is a full geocoder with autocomplete that can combine OSM
  with other sources.
* Bad, because it is a family of services: Elasticsearch, the API,
  placeholder, the interpolation and PIP services, libpostal at around 2 GB
  RAM, and a set of importers. That is several workloads and pipelines to run
  for what one Photon does.

### 6. Public komoot instance, or a commercial API

* Good, because there is nothing to run.
* Bad, because every keystroke leaves for a third party. komoot's instance
  carries no availability promise and throttles heavy use
  ([README](https://github.com/komoot/photon)). The commercial APIs are mostly
  US processors, a harder case under the GDPR than an Austrian authority.

## More Information

Switching it on for a stack:

1. Set `grid-oib:geocoderEnabled: "true"` in `Pulumi.<stack>.yaml`.
2. Check that the cluster allows egress to `download1.graphhopper.com` and
   `github.com` on 443.
3. Run `pulumi preview`, then `pulumi up`. Watch
   `kubectl -n grid logs geocoder-0 -c fetch`: the first start downloads about
   1 GB.

Revisit when:

* the Gemeinde is wrong in a measurable share of setup reviews (option 2, as a
  lookup);
* stale addresses show up in support (add a CronJob that restarts the pod on a
  schedule);
* a second country is supported (a second extract);
* GraphHopper stops publishing country extracts (build from the JSON dump).

Sources, read 2026-10-20: [Photon](https://github.com/komoot/photon),
[Photon releases](https://github.com/komoot/photon/releases),
[Photon API](https://github.com/komoot/photon/blob/master/docs/api-v1.md),
[GraphHopper Photon downloads](https://download1.graphhopper.com/public/),
[photon country extracts (2020)](https://nominatim.org/2020/10/21/photon-country-extracts.html),
[BEV Adressregister](https://bev.gv.at/Services/Produkte/Adressregister.html),
[OSM wiki, Österreichisches Adressregister](https://wiki.openstreetmap.org/wiki/Austria/%C3%96sterreichisches_Adressregister),
[rtuszik/photon-docker](https://github.com/rtuszik/photon-docker) (the
community image considered and not used).
