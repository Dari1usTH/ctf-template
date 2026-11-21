# Contract V1

## Componente

- `server.mjs`: server HTTP Node.js, autentificare, protecție pentru cereri și fișiere statice. Fără framework sau dependențe externe.
- `core.mjs`: parsare literală config, descoperire challenge-uri, validator, scaner, plan și fingerprint.
- `workspace.mjs`: pregătire, execuție Bash, publicare de loturi, inspector/diff, operații persistente și undo.
- `../pack-public`, `../pack-private`, `../util/pack-common`: împachetare Bash cu GNU tar. Interfața folosește modul `--prepared`; CLI-ul acceptă în continuare zero sau mai multe directoare de challenge.
- `scripts/trash.sh`: mutări reversibile, fără ștergere definitivă.
- `public/`: HTML/JS/CSS fără build; toate textele provenite din fișiere se inserează prin `textContent`.

Containerul montează rădăcina proiectului la `/workspace`, rulează cu UID/GID-ul autorului, nu montează socket-ul Docker și nu instalează pachete la pornire. Sistemul de fișiere al imaginii este read-only; fișierele de lucru sunt în bind mount și `/tmp`.

## API

Toate rutele, cu excepția healthcheck-ului, loginului și fișierelor statice, cer cookie-ul `ctf_session`. Sesiunea este HttpOnly, SameSite=Strict, valabilă 12 ore, păstrată în memoria procesului. Tokenul persistent nu apare în manifest sau loguri. POST cere `Content-Type: application/json`, `X-CTF-Request: 1` și o origine corespunzătoare gazdei dacă există antetul Origin. Nu există CORS. Corpul cererii are limita de 4 MiB.

| Metodă | Rută | Intrare / rezultat |
| --- | --- | --- |
| GET | `/api/health` | `{ok:true}`; nu citește challenge-uri |
| POST | `/api/login` | `{token}`; setează cookie-ul |
| POST | `/api/logout` | `{}`; invalidează sesiunea |
| GET | `/api/session` | stare, fus orar, operație în curs |
| GET | `/api/challenges` | `{config,challenges:[{id,name,category,files,issues,defaults}]}` |
| POST | `/api/preview` | `{selections:[{id,public:[cale],private:[cale]}]}`; întoarce planul, tokenul, expirarea și `blocked` |
| POST | `/api/pack` | `{token}`; revalidează planul, creează lotul și întoarce manifestul (201) |
| GET | `/api/batches` | loturi, fișiere actuale și arhivele originale cu `missing` |
| GET | `/api/download?path=...` | cale relativă la `Challenges/`; descarcă un fișier |
| GET | `/api/inspect?path=...` | verifică SHA256, index de fișiere și diff față de arhiva precedentă |
| POST | `/api/delete` | `{path}` relativ la `Challenges/`; mutare în coș |
| GET | `/api/history` | operații de creare/ștergere, inclusiv starea undo |
| POST | `/api/undo` | `{id}`; anulează o creare sau restaurează o ștergere |
| GET | `/api/logs` | ultimele 300 de evenimente, cel mai recent primul |

Erorile sunt `{error:"mesaj"}`: 400 cerere invalidă, 401 autentificare, 403 origine/antete invalide, 404 resursă absentă, 409 conflict/stare schimbată/ocupat, 413 cerere prea mare, 422 validare/scurgere care blochează arhivarea, 429 prea multe încercări de autentificare și 500 eroare de execuție.

ID-ul challenge-ului este `categorie/nume`. Listele din selecție conțin fișiere individuale relative la challenge. Directoarele nu sunt intrări selectabile. Public și private sunt selecții independente. Numărul maxim este 300 de challenge-uri per plan și 30.000 de intrări per challenge.

## Plan și execuție

Planul conține `config`, `jobs`, `issues`, `scripts`, `bytes`, `fingerprint`, `blocked`, `token`, `expiresAt`. Fiecare job include challenge-ul, vizibilitatea, scriptul și intrările cu sursă, cale rezultată, dimensiune, SHA256 și mod normalizat. Planurile expiră după 15 minute și sunt ținute în memorie (maximum aproximativ 100).

La execuție se reconstruiește planul și se compară fingerprint-ul cu previzualizarea. Fișierele sunt apoi copiate în `.ctf-author/build/<id>/input-N/`, iar conținutul copiilor este verificat înainte de scripturi. Scripturile revizuite sunt și ele copiate și verificate în staging, astfel încât modificările din timpul lotului să nu schimbe comenzile executate. `pack-public --prepared STAGING OUTPUT NAME MTIME` și echivalentul privat lucrează numai pe aceste copii. Fiecare script are timeout de 120 secunde; grupul de procese este oprit la timeout. Operațiile de creare, ștergere și undo sunt serializate în proces; cererile concurente primesc 409. Rulează un singur container per workspace.

Arhivele, manifestul și checksum-urile sunt pregătite în `build/<id>/batch/`. Un rename pe același bind mount publică întregul lot. La eșec, stagingul operației este curățat; la oprire brutală poate rămâne în afara `Challenges/`. Căile absolute, traversările, controalele de terminal, symlink-urile și fișierele speciale sunt refuzate.

## Manifest v1

`Challenges/<lot>/manifest.json`:

```json
{
  "version": 1,
  "id": "uuid-operație",
  "createdAt": "2026-11-21T08:00:00.000Z",
  "timezone": "Europe/Bucharest",
  "folder": "2026-11-21",
  "tarMtime": "2016-09-01",
  "scripts": [{"path": "pack-public", "sha256": "..."}],
  "warnings": [],
  "archives": [{
    "challenge": "sample/piece_of_pie",
    "kind": "public",
    "path": "public/piece_of_pie_<md5>.tar",
    "size": 20480,
    "md5": "...",
    "sha256": "...",
    "files": [{
      "source": "public/piece_of_pie",
      "path": "piece_of_pie/piece_of_pie",
      "size": 9000,
      "sha256": "...",
      "mode": "0755"
    }]
  }]
}
```

Manifestul nu conține valorile flag-urilor. Poate include nume și căi de fișiere private și este pentru autor. `checksums.txt` folosește formatul cu etichete `MD5 (cale) = valoare` și `SHA256 (cale) = valoare`. Inspectorul verifică checksum-ul arhivei înainte de afișarea indexului din manifest; nu extrage arhive pe disc. Comparația folosește căi, SHA256 și modul de execuție; schimbările de mtime sunt ignorate. Manifestele sunt metadate locale de încredere, nu semnături criptografice împotriva modificării deliberate a întregului workspace.

## Jurnal și undo

`.ctf-author/events.jsonl` are câte un obiect JSON pe linie: `at`, `type` și, după caz, `operation`, `script`, `challenge`, `message`, `path`, `blocked`. Tipuri: `preview`, `script-start`, `script-done`, `create`, `delete`, `undo`, `error`, `recovered`. stdout/stderr este capturat limitat la 32 KiB pentru raportarea erorilor de script; flag-urile nu sunt scrise intenționat în loguri.

`.ctf-author/operations/<uuid>.json` este înregistrarea durabilă folosită la undo. Câmpuri: `id`, `type` (`create`, `delete`, `undo`), `createdAt`, `from`, `to`, `status`, `path`; undo mai are `undoOf`, iar operația anulată are `undoneBy`. Stări: `pending`, `done`, `undone`, `failed`, `conflict`.

Operația este scrisă atomic înainte de mutare și actualizată după mutare. La pornire, o operație `pending` este reconciliată: sursă absentă și destinație prezentă înseamnă `done`; sursă prezentă și destinație absentă înseamnă `failed`; alte combinații devin `conflict`. Undo-urile finalizate sunt reconciliate cu operațiile lor părinte. Recuperarea vizează întreruperea procesului, nu garanții împotriva defectării discului sau a pierderii alimentării fără fsync.

Ștergerile mută în `.ctf-author/trash/<uuid>/item`; undo mută înapoi, dacă părintele există și destinația este liberă. Anularea creării mută lotul în coș. Nu există redo sau golire automată a coșului. `manifest.json` și `checksums.txt` se șterg numai odată cu lotul pentru a păstra informațiile de inspecție și recuperare.

## Import and checksum endpoints

| Method | Route | Request / result |
| --- | --- | --- |
| POST | `/api/import/start` | `{kind:"folder"|"archive",category,name}` → `{token}` |
| POST | `/api/import/upload?token=...&path=...` | Binary body (`application/octet-stream`), same session/origin/header checks; 256 MiB/file |
| POST | `/api/import/review` | `{token}` → target, file tree, issues and staging fingerprint |
| POST | `/api/import/confirm` | `{token}` → durable `import` operation; publishes reviewed staging |
| POST | `/api/import/cancel` | `{token}` → removes temporary import |
| POST | `/api/challenge/delete` | `{id:"category/name"}` → durable `challenge-delete` operation |
| POST | `/api/check` | `{folder}` → MD5/SHA256/size verification for every archive in the manifest |

`imports.mjs` stages uploads in `.ctf-author/imports/<token>/`. Archive extraction runs `scripts/extract.sh` and the Python standard-library extractor. All headers are validated before extraction, only regular files/directories are accepted, byte/entry limits are enforced, and extracted file bytes are checked before confirmation. A durable rename publishes the imported directory only after user confirmation. Import/delete/confirm/undo/check operations share the workspace lock. Source mutations clear package previews.

Undo supports `import` and `challenge-delete`. New move operations record the source device/inode so undo cannot move a different item that later reused the same path. Check reports are stored in `.ctf-author/checks/<folder>.json` and matched to the manifest batch ID. The report represents its recorded check time; it is refreshed by the user with Check.
