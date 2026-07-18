# La Guilde — QG des soirées jeux

Application web pour proposer des jeux, les noter entre amis, et lancer des aventures.

## Contenu

- `server.js` — le serveur : API REST + temps réel + connexion à la base de données
- `package.json` — la liste des dépendances (Express, pg) que Render installe tout seul
- `public/index.html` — l'application web servie aux joueurs

## Configuration requise

Une seule variable d'environnement à définir sur Render :

- `DATABASE_URL` — la chaîne de connexion de la base Postgres (fournie par Neon)

## Commandes

- Démarrage : `npm start` (Render le fait automatiquement)

Au premier démarrage, le serveur crée les tables et insère les jeux de départ.
