## Local

```powershell
npm install
node server.js
```

## Docker

Le projet peut etre lance avec l'API Node.js et PostgreSQL via Docker Compose.

```powershell
docker compose up --build
```

Pour arreter les conteneurs :

```powershell
docker compose down
```

L'API sera exposee sur `http://localhost:8443/api/v1`.

Exemples rapides :

```powershell
Invoke-RestMethod http://localhost:8443/
Invoke-RestMethod http://localhost:8443/api/v1/simulation/ping
```

Note : le port `8443` est utilise, mais l'API est encore en HTTP tant que TLS n'a pas ete configure.
