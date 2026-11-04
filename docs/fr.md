# Music Assistant pour Gladys

Intégration communautaire, sans lien avec le projet Music Assistant. Elle relie
Gladys à un serveur [Music Assistant](https://www.music-assistant.io/) que vous
faites déjà tourner : chaque lecteur de Music Assistant (enceinte HEOS, Sonos,
Chromecast, AirPlay, Snapcast, groupe…) devient un **lecteur de musique Gladys**,
avec le catalogue de tous les fournisseurs ajoutés dans Music Assistant
(**Qobuz**, **Spotify**, radios, fichiers locaux…).

> **Version 0.1.0, à tester.** Elle a été vérifiée contre l'image officielle
> Music Assistant 2.10.9 avec des fournisseurs intégrés sans compte, mais n'a
> **jamais été testée avec un vrai compte** Qobuz ou Spotify ni avec une vraie
> enceinte. Vos retours sont les bienvenus.

## Ce que vous obtenez

- Un lecteur de musique Gladys par lecteur Music Assistant : lecture, pause,
  arrêt, précédent, suivant, volume, sourdine, position (avance rapide),
  aléatoire, répétition, et le morceau en cours avec sa pochette pour le widget
  Musique.
- Le **catalogue** dans Gladys : parcourir (dossiers de chaque fournisseur ; un
  artiste ouvert liste ses albums **du plus récent au plus ancien**, avec
  l'année), chercher (titres, albums, artistes, playlists, radios), jouer en
  remplaçant la file, **ensuite** ou **à la fin**, voir la file d'attente et y
  sauter.
- Des **actions de scène** : jouer par recherche (dont « le dernier album de
  … » et la radio d'un artiste), régler le volume, regrouper ou séparer deux
  lecteurs.

La commande vocale n'est pas gérée ici : c'est Gladys qui s'en charge, avec
le lecteur et les actions de scène ci-dessus.

## Avant de commencer : Music Assistant

Music Assistant tourne **à part** de Gladys :

- en conteneur Docker **en réseau hôte**
  (`ghcr.io/music-assistant/server`, `network_mode: host`, un volume `/data`),
  voir l'[installation](https://www.music-assistant.io/installation/) ;
- ou en add-on Home Assistant.

Il a besoin du réseau hôte pour découvrir les enceintes et leur servir le
flux audio. C'est pour cela qu'il n'est pas lancé par l'intégration : les
conteneurs de Gladys vivent sur un réseau isolé. L'intégration se connecte
simplement à son API locale (port 8095), comme l'application web de Music
Assistant.

Version minimale : Music Assistant **2.8**. L'authentification est obligatoire
depuis la 2.7 : il faut un jeton.

### Vos comptes Qobuz et Spotify restent dans Music Assistant

Ajoutez Qobuz, Spotify et vos autres fournisseurs **dans l'interface de Music
Assistant** (Paramètres > Fournisseurs de musique). L'intégration ne parle
jamais directement à Qobuz ni à Spotify, ne voit jamais vos identifiants et ne
configure aucun fournisseur à votre place : c'est Music Assistant qui porte la
relation avec ces services.

- **Qobuz** : abonnement payant. Recherche, albums, playlists et albums d'un
  artiste fonctionnent. La radio d'un artiste est **pauvre** avec Qobuz seul
  (Qobuz ne fournit pas de titres similaires). Les pochettes d'un artiste
  absent de votre bibliothèque peuvent manquer.
  [Page Qobuz de Music Assistant](https://www.music-assistant.io/music-providers/qobuz/).
- **Spotify** : compte **Premium** obligatoire. Music Assistant joue soit par
  librespot (ne marche généralement pas avec un compte créé depuis
  décembre 2024), soit par Spotify Soloist (marche avec tous les comptes
  Premium, réseau hôte obligatoire, un seul flux à la fois par compte) : le
  choix se fait dans Music Assistant. Un **Client ID Spotify personnel** est
  conseillé : sans lui, les recherches passent par un quota partagé lent.
  La radio d'un artiste est riche avec Spotify.
  [Page Spotify de Music Assistant](https://www.music-assistant.io/music-providers/spotify/).

### Créer le jeton

1. Dans Music Assistant, créez de préférence un **utilisateur dédié** à Gladys
   (Paramètres > Utilisateurs). Le rôle « user » suffit ; un rôle plus limité
   n'a pas encore été essayé.
2. Connecté avec cet utilisateur, ouvrez **Paramètres > Profil > Jetons
   d'accès longue durée** et créez un jeton (valable un an).
3. Copiez-le : Music Assistant ne le réaffiche pas.

## Configuration

1. Installez l'intégration, puis ouvrez son onglet **Configuration**.
2. **Adresse de Music Assistant** : `http://192.168.1.20:8095`, ou simplement
   `192.168.1.20` (port 8095 par défaut). Le bouton **Trouver Music
   Assistant** cherche le serveur sur le réseau local (mDNS `_mass._tcp`, par
   Gladys) et remplit l'adresse quand un seul serveur répond. Vérifiez
   l'adresse trouvée : un appareil du réseau local pourrait se faire passer
   pour Music Assistant.
3. **Jeton longue durée** : collez le jeton. Il est gardé par Gladys dans sa
   base, jamais réaffiché, envoyé seulement à votre serveur Music Assistant.
4. **Plafond de volume** (60 % par défaut) : voir plus bas.
5. **Fournisseur préféré** : Automatique, Qobuz ou Spotify (voir « Jouer par
   recherche »).
6. Enregistrez, puis cliquez sur **Tester la connexion** : le message liste
   la version de Music Assistant, si Qobuz et Spotify sont présents, les
   fournisseurs de musique et les lecteurs.
7. Ouvrez l'onglet **Découverte** et ajoutez les lecteurs voulus.

### Ce que dit l'état de la connexion

- « Connecté à … (Music Assistant 2.10.9) : N lecteur(s) », avec un
  avertissement quand le jeton expire dans moins de 30 jours, ou a expiré.
- « Music Assistant ne répond pas » / « La connexion a été perdue » : nouvel
  essai après 2 s, puis 4, 8… jusqu'à 5 minutes entre deux essais.
- « n'est pas un serveur Music Assistant » : mauvais port, ou autre service.
  Le jeton n'est envoyé qu'après avoir reconnu le message d'accueil de Music
  Assistant.
- « n'est pas encore configuré » : créez le premier utilisateur dans Music
  Assistant.
- « trop ancien » (avant 2.8) ou « a changé son API » (mettez l'intégration à
  jour).
- « a refusé le jeton » : jeton révoqué, expiré ou mal recopié. L'intégration
  **arrête alors d'essayer**, même après un redémarrage (elle ne garde dans
  `/data` qu'une marque de 2 caractères hexadécimaux, jamais le jeton). Elle
  réessaie quand vous enregistrez la configuration (nouveau jeton ou non), ou
  quand **Tester la connexion** réussit avec le jeton enregistré.
- « a refusé la connexion (erreur N), pas le jeton » : autre refus à
  l'accueil de Music Assistant ; nouvel essai plus tard.

## Le plafond de volume

Aucune commande de l'intégration ne règle un volume au-dessus du plafond
(1 à 100 %, 60 % par défaut, 100 = pas de plafond) :

- un volume plus fort demandé par le tableau de bord ou une scène est ramené
  au plafond ; sur un **lecteur de type groupe** de Music Assistant, le volume
  est réglé membre par membre (chacun au plus au plafond), pas sur le groupe ;
- avant de **lancer du son** (lecture, précédent, suivant, jouer un média,
  sauter dans la file, jouer par recherche), de **couper la sourdine** ou
  d'**ajouter un lecteur à un groupe**, l'intégration ramène au plafond le
  lecteur réglé plus fort dans Music Assistant, **les membres de son groupe**
  et, s'il joue dans un groupe, son meneur et les autres membres ; un membre
  hors ligne est ignoré ;
- un volume inconnu est relu dans Music Assistant ; toujours inconnu, rien
  n'est lancé (message « volume inconnu ») ; si l'abaissement échoue, rien
  n'est lancé non plus.

Une baisse de volume, la pause, l'arrêt et la sourdine ne sont retenus ni par
le plafond, ni par les commandes en attente (jusqu'à 128 commandes en vol).
Ils échouent seulement si Music Assistant est injoignable ou ne répond pas,
s'il ne connaît plus le lecteur, si le lecteur n'a pas de volume ou de
sourdine, ou si Music Assistant refuse lui-même la commande. Le volume réglé
dans l'application Music Assistant elle-même n'est pas modifié tant que
Gladys ne fait rien jouer.

### Délais

Gladys attend 5 s une commande, 10 s une demande du lecteur (parcourir,
chercher, jouer, file) et le délai déclaré d'une action de scène (30 s pour
« jouer par recherche »). L'intégration se donne un budget un peu plus court
(4,5 s, 8,5 s, 27 s) pour toutes les requêtes d'un même appel : passé ce
budget, elle n'envoie plus rien et répond « Music Assistant est trop lent ».
Une commande qui lance du son n'est envoyée que s'il reste au moins 1,5 s.

## Le lecteur de musique

Le widget Musique et l'action de scène « Jouer un média » du cœur de Gladys
utilisent directement le lecteur :

- **Parcourir** : la racine montre les fournisseurs de Music Assistant ;
  ouvrez un dossier, un artiste (ses albums, le plus récent d'abord, avec
  l'année et le fournisseur), un album ou une playlist.
- **Chercher** : titres, albums, artistes, playlists, radios, sur tous les
  fournisseurs. Le sous-titre indique l'artiste, l'année d'un album et le
  fournisseur (« Céline Dion · 2019 · Qobuz »).
- **Jouer** : remplacer la file, jouer ensuite, ou ajouter à la fin.
- **File d'attente** : la liste, la position en cours, et le saut à une
  position.
- **Pochettes** : servies par le proxy d'images de Music Assistant (512 px pour
  le morceau en cours, 256 px dans les listes), 300 Ko au plus.

## Actions de scène

### Music Assistant : jouer par recherche

- **Lecteur**, **Texte à chercher** (accepte les variables de scène).
- **Quoi jouer** : titre, album, playlist, artiste, **dernier album de
  l'artiste**, **radio de l'artiste**, station de radio.
- **Fournisseur** : comme dans la configuration, Automatique, Qobuz d'abord ou
  Spotify d'abord. Avec Qobuz ou Spotify, l'intégration cherche d'abord dans ce
  fournisseur (y compris les éléments de votre bibliothèque qui en viennent) et
  joue sa copie ; s'il n'a rien, ou s'il n'est pas configuré dans Music
  Assistant, elle cherche partout.
- **File d'attente** : remplacer et jouer, jouer ensuite, ajouter à la fin.
- Sorties : le titre joué, le fournisseur, l'année (pour un album).

**« Le dernier album de Céline Dion »**, pas à pas :

1. Nouvelle scène, déclencheur de votre choix.
2. Action **Music Assistant : jouer par recherche** : lecteur « Salon »,
   texte « Céline Dion », quoi jouer « Dernier album de l'artiste »,
   fournisseur « Qobuz d'abord ».
3. L'intégration trouve l'artiste, lit ses albums **chez ce fournisseur**,
   et choisit ainsi :
   - le **type** donné par Music Assistant : album (jamais single, EP, live,
     compilation ni bande originale **quand Music Assistant les type ainsi**) ;
   - des **mots du titre**, seulement sous une forme révélatrice : « Greatest
     Hits », « Les plus grands succès », « Original Motion Picture
     Soundtrack », « Bande originale du film » partout ; « Best Of »,
     « Collection », « Anthology », « Essentials », « L'essentiel »,
     « Soundtrack » comme titre entier, entre parenthèses, après « - », ou à
     côté du nom de l'artiste (« The Essential Céline Dion ») ; « (OST) »,
     « (B.O.) » entre parenthèses ; « Live at… », « Live à… », « (Live) »,
     « En concert », « Unplugged » pour un live. « Live Forever », « Live in
     Love », « Best of Me » ou « Essential Love » restent des albums studio ;
   - une **réédition** (remaster, deluxe, édition…) n'est écartée que si
     l'original du même titre est dans la liste : un nouvel album sorti
     seulement en « Deluxe Edition » reste ;
   - puis l'**année la plus récente** (à égalité : l'ordre de Music Assistant).

Ce tri repose seulement sur le type de Music Assistant et sur ces mots : il
peut se tromper, par exemple sur un live sans mot révélateur (« Au Palais
Omnisports »), un best-of au titre neutre, ou une réédition au titre changé.
Les sorties de l'action (titre, année, fournisseur) montrent ce qui a été joué.
D'après son code, Music Assistant lit au plus les 100 premières sorties d'un
artiste Qobuz ; si aucun album gardé n'a d'année, l'action le dit au lieu de
jouer au hasard.

### Music Assistant : régler le volume

Règle le volume d'un lecteur, jamais au-dessus du plafond. Sortie : le volume
réellement réglé.

### Music Assistant : regrouper deux lecteurs / sortir un lecteur de son groupe

Ajoute un lecteur au groupe d'un meneur (ramené au plafond d'abord), ou le
sépare. Music Assistant doit accepter ces deux lecteurs ensemble.

## Bon à savoir

- **HEOS (Denon, Marantz)** : un ampli peut apparaître deux fois dans Gladys
  (intégration de l'ampli + lecteur Music Assistant). Chacun garde son rôle :
  entrées et alimentation d'un côté, musique de l'autre. Un ampli multizone
  est un seul lecteur dans Music Assistant.
- L'état « en cours de lecture » vient des événements de Music Assistant,
  sans interrogation périodique.
- `/data` ne garde que la marque d'un jeton refusé et son sel aléatoire.

## Dépannage

Les journaux de l'intégration (onglet Supervision) disent chaque connexion
(« connected to … : N player(s), music providers: qobuz, spotify »), chaque
perte et chaque nouvel essai, sans jamais écrire le jeton. Mettez
`LOG_LEVEL=debug` pour plus de détails.
