# CTF Author — V1

Interfață web locală pentru autorii de challenge-uri CTF. Arhivarea se execută în Bash; serverul și interfața sunt JavaScript, fără dependențe npm. Interfața este în engleză, cu texte scurte. CSS-ul folosește doar alb, negru-albăstrui și albastru.

## Pornire prin Docker

Ai nevoie de Docker Engine / Docker Desktop pornit și Docker Compose v2. Nu trebuie să instalezi Node pe calculatorul autorului.

Din rădăcina acestui proiect:

```bash
./run.sh
```

Dacă există deja o instanță CTF Author (pornită sau oprită), scriptul întreabă dacă vrei repornirea ei. La `y` / `yes` / `da` oprește doar containerele acestei aplicații și recreează platforma; la Enter sau `n` păstrează instanța existentă. `./run.sh --yes` confirmă automat repornirea. Arhivele, jurnalul și tokenul se păstrează.

Scriptul construiește imaginea, pornește containerul, așteaptă healthcheck-ul și afișează adresa locală, adresele LAN candidate și tokenul de conectare. Deschide `http://localhost:8080` sau `http://<IP-ul-autorului>:8080` pe un dispozitiv din aceeași rețea. Portul trebuie să fie accesibil prin firewall-ul calculatorului autorului. Tokenul se păstrează în `.ctf-author/access-token` și rămâne valabil la repornire. Sesiunile web expiră după 12 ore și la repornirea serverului.

Opțiuni de pornire:

```bash
CTF_PORT=8090 ./run.sh
CTF_BIND=127.0.0.1 ./run.sh          # acces doar de pe calculatorul autorului
CTF_TIMEZONE=Europe/Bucharest ./run.sh
```

Implicit se montează directorul curent. Poți seta `CTF_WORKSPACE=/cale/absoluta/proiect` dacă acesta conține `config`, `pack-public`, `pack-private` și `util/pack-common` din versiunea curentă. Fișierele sunt scrise cu UID/GID-ul utilizatorului care rulează scriptul. Pentru un Docker Engine local pe Linux aceasta păstrează proprietarul fișierelor; Docker Desktop gestionează permisiunile prin propriul bind mount.

Oprire și verificare:

```bash
docker compose --project-name ctf-author down
docker compose --project-name ctf-author ps
docker compose --project-name ctf-author logs --tail=100
```

Dacă ai pornit din alt director, adaugă `-f /cale/ctf-template/compose.yaml`. Oprirea nu șterge arhivele, jurnalul sau coșul. Aplicația este destinată unei rețele LAN de încredere; nu publică automat nimic pe internet.

## Fluxul de lucru

1. Pregătește challenge-urile în structura `categorie/challenge/`, apoi rulează separat buildurile necesare (`./make-src`, `./public-src`, opțional `./private-src`). Interfața nu execută Makefile-uri.
2. Deschide „Challenges”. Categoriile sunt citite din `config`; subdirectoarele lor sunt challenge-uri. Selectează challenge-urile dorite. La fiecare, fișierele din `public/` sunt bifate pentru arhiva publică, iar cele din `private/` pentru cea privată. Selecția challenge-urilor pornește goală.
3. Extinde lista de fișiere pentru a include/exclude fișiere individuale. Fișierele suplimentare se aleg din interiorul challenge-ului. Soluțiile și sursele pot fi incluse în arhiva privată.
4. Apasă „Review package”. Vezi erorile, avertismentele, arborele rezultat, dimensiunile și comenzile `pack-public` / `pack-private` care urmează să ruleze. Acest pas nu execută scripturi de build sau arhivare și nu modifică sursele.
5. Rezolvă erorile și repetă verificarea. Erorile de validare și scurgerile blochează arhivarea; avertismentele din README permit continuarea. Apasă „Create archives” după verificarea previzualizării.
6. Din „Archives” poți descărca, copia checksum-uri, inspecta conținutul și compara cu cea mai recentă arhivă precedentă pentru același challenge și aceeași vizibilitate. Pe HTTP în LAN, dacă browserul blochează clipboard-ul automat, butonul selectează checksum-ul pentru copiere cu Ctrl+C / Cmd+C.
7. Șterge o arhivă, directorul `public/` sau `private/`, ori întregul lot. Datele sunt mutate în coș, nu șterse definitiv. „History & undo” restaurează ștergerile sau anulează crearea unui lot. Dacă ai șters și părintele unui fișier, restaurează mai întâi părintele. Destinațiile existente nu sunt suprascrise.

Rescanarea resetează selecția. Previzualizările sunt valabile 15 minute, doar până la prima utilizare, și se invalidează dacă se schimbă conținutul selectat, permisiunile de execuție, flag-urile relevante, configurația sau scripturile. După repornire trebuie refăcute.

## Rezultate

```text
Challenges/
  2026-11-21/
    public/
      piece_of_pie_<md5>.tar
    private/
      # Arhivele private, dacă au fost selectate fișiere
    manifest.json
    checksums.txt
.ctf-author/
  access-token
  events.jsonl
  operations/         # Jurnalul persistent pentru undo și recuperare
  trash/              # Rezultate mutate în coș
  build/              # Pregătire temporară, în afara rezultatelor publicate
```

La o nouă arhivare în aceeași zi, numele lotului devine `<data>_<ora-UTC>_<id-scurt>` pentru a păstra rezultatele anterioare. Ziua se calculează în fusul `CTF_TIMEZONE`, implicit `Europe/Bucharest`. Fiecare lot conține ambele directoare, inclusiv când unul rămâne gol.

În `.tar`, conținutul implicit al `public/` sau `private/` apare sub `<challenge>/`, ca în template-ul inițial. Fișierele suplimentare își păstrează calea relativă: `README.md` devine `<challenge>/README.md`, iar `src/foo.c` devine `<challenge>/src/foo.c`. Coliziunile între căi sunt respinse. Challenge-urile cu același nume din categorii diferite se arhivează în loturi distincte.

Timestamp-ul, proprietarul (0:0), ordinea fișierelor și permisiunile sunt normalizate: directoare și executabile `0755`, restul `0644`. Același conținut, aceleași nume și aceiași biți de execuție produc aceleași arhive folosind imaginea curentă. Numele ambelor tipuri este `<challenge>_<md5>.tar`; vizibilitatea este dată de director. Checksum-urile pot diferi față de versiunea veche a scripturilor, care nu normaliza toate metadatele.

Manifestul și `checksums.txt` sunt înregistrările inițiale ale lotului. Dacă ștergi o arhivă, aceasta apare indisponibilă în UI; metadatele istorice se păstrează pentru undo. Jurnalul complet este `.ctf-author/events.jsonl`, iar interfața afișează ultimele 300 de evenimente. Coșul nu se golește automat. Directoarele rămase în `build/` după o întrerupere sunt ignorate și pot fi curățate manual cu aplicația oprită.

## Validare și scanare

`config` păstrează formatul Bash al template-ului; interfața citește numai atribuiri literale și nu îl execută:

```bash
categories="crypto exploit misc reverse web sample"
tar_mtime="2016-09-01"
flag_prefix="OWASPCTF"
```

Validatorul verifică `README.md`, un `flag` nevid, directoarele `src/`, `sol/`, `public/`, `src/Makefile` cu țintele `clean` și `public`, precum și o soluție nevidă în orice format. Secțiunile README (descriere, vulnerabilitate, soluție, mediu, deploy) sunt avertismente. Prefixul și flag-urile duplicate sunt verificate între toate challenge-urile scanate. Eliminarea lui `flag_prefix` dezactivează verificarea de prefix și generează un avertisment.

Scanarea selecției publice detectează:

- flag-uri exacte din toate challenge-urile, inclusiv în fișiere binare;
- `sol/`, `.git`, `.env` și variante, `flag`, `__pycache__`, fișiere Python compilate și backup-uri uzuale de editor;
- fișiere selectate din `private/` și copii identice, ne-goale, ale fișierelor private din același challenge.

Scanarea nu decomprimă arhive imbricate și nu identifică secrete codificate, transformate sau fragmente arbitrare de conținut privat. Symlink-urile și fișierele speciale nu pot fi incluse; `.git/` nu este traversat. Nu se execută automat soluții sau Makefile-uri. Smoke-testul și exportul CTFd JSON/CSV sunt amânate.

## Dezvoltare și teste

Cu Node.js 22+, Bash, GNU tar și coreutils instalate:

```bash
npm test
npm start
```

Nu există dependențe npm de instalat. `npm start` folosește proiectul curent și creează tokenul dacă lipsește; citește-l local din `.ctf-author/access-token`. Documentația API, manifestului și jurnalului este în [app/ARCHITECTURE.md](app/ARCHITECTURE.md).

---

# Documentația template-ului inițial

# CTF Name

The CTF (Capture the Flag) Template (TODO: Name) contest takes place on (TODO: date).

Challenges are split in categories and each category contains several challenges. Each category is a folder and each challenge is a folder in its category folder. Categories are listed in the `config` file:
```
categories="crypto exploit misc reverse web sample"
```
The `config` file also defines the timestamp to use for challenge archives. You need this to keep archive files identical if created using the same contents but at different timestamps; it means identical checksums that can then be verified by participants.

## Creating a Challenge

A challenge is created as a subfolder in its category folder. A sample challenge folder is `sample/piece_of_pie/` with the contents below:
```
sample/piece_of_pie/
|-- README.md
|-- public/
|   `-- piece_of_pie*
|-- flag
|-- sol/
|   `-- exploit.py
`-- src/
    |-- .gitignore
    |-- Makefile
    `-- piece_of_pie.c
```
As above, the challenge folder must have:
* a `README.md` similar to the one in the `sample/piece_of_pie` folder that provides:
  * the challenge title
  * the challenge description, also showing hints and score
  * a description of the vulnerability
  * a description of the exploit/solution
  * instructions on deploying it and its required environment
* a `flag` file containing the flag to be captured;
* a `src/` subfolder used for building the challenge. It must provide a `Makefile` file with a `clean` and `public` target (possibly a `private` target). If building source code files, provide a `.gitignore` file that ignores output files (such as executables). The relevant output files are to be placed in the `public/` subfolder.
* a `sol/` subfolder containing the solution/exploit script. It is recommended to name it `exploit.py` or similar.
* a `public/` subfolder where build results from the `src/` subfolder and additional required files are to be placed. The contents of this folder are to be packed into the challenge archive that will be be published to the participants.
* an optional `private/` subfolder folder where private build results from the `src/` subfolder are to be placed. The contents of this folder are to be packed into the challenge archive that will be be deployed privately in the CTF infrastructure.

## Packing a Challenge

After creating the challenge, we create a `.tar` file that will be published to the participants. The name of the `.tar` file will consist of the challenge folder name and the MD5 sum of the archive, such that participants can check they have the correct file.

We use the `pack-public` script to create a challenge archive. We either pass it the path to the challenge subfolder (multiple arguments are allowed) or we run it with no arguments, in which case it walks through all challenge subfolders. A sample run is:
```
$ ls
crypto  exploit  misc  reverse  sample  web  README.md  clean-src  config  make-src  pack-private  pack-public  private-src  public-src


$ ./pack-public
Packing public for sample/piece_of_pie ...


$ ls
crypto   misc     sample  README.md  config    pack-private  piece_of_pie_43990b11e9561be8a952cadc23a9caf4.tar  public-src
exploit  reverse  web     clean-src  make-src  pack-public   private-src


$ md5sum piece_of_pie_43990b11e9561be8a952cadc23a9caf4.tar
43990b11e9561be8a952cadc23a9caf4  piece_of_pie_43990b11e9561be8a952cadc23a9caf4.tar
```
After running the `pack-public` script, we get the `piece_of_pie_43990b11e9561be8a952cadc23a9caf4.tar` file: the challenge folder name `piece_of_pie` followed by the MD5 sum of the file.

There are similar scripts to automate other actions. They are invoked similar to the `pack-public` script:
* the `make-src` script builds result files in the `src/` subfolder; it invokes `make` in the `src/` subfolder;
* the `clean-src` script cleans output and intermediary files the `src/` subfolder; it invokes `make clean` in the `src/` subfolder;
* the `public-src` script copies result files from the `src/` subfolder to the `public/` subfolder; it invokes `make public` in the `src/` subfolder;
* the `private-src` script copies private files (for deployment use only, not available to participants) from the `src/` subfolder to the `private/` subfolder;
* the `pack-private` script creates a private challenge archive from the `private/` subfolder.

## Deploying a Challenge

Deploying a challenge usually requires a virtual machine where to deploy it. We will use virtual machines in the [NCIT Cluster in UPB](http://curs.pub.ro/index.php/projects/projects-cursuri-upb/17-general/general/13-ncit-cluster-homepage) and the [xinetd-based approach](https://github.com/pwning/docs/blob/master/suggestions-for-running-a-ctf.markdown#remote) for deploying challenge binaries and flags. The `utils/` subfolder contains helpful scripts for setting up and using the infrastructure.

For flags we use the `TODO_CTF` prefix followed by a random string in curly brackets, e.g. `TODO_CTF{jumping_Jehoshaphat}`. Unless otherwise stated, we place flag files in `/home/ctf/flag` on the remote system.
