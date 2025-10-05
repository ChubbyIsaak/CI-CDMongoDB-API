# CICD Safe Changes API v4

API Express + TypeScript para aplicar cambios de esquema en MongoDB de forma segura, auditable y trazable, con integraciones opcionales hacia Artifactory y Jira.

---

## Tabla de contenidos

- [Resumen rápido](#resumen-rápido)
- [Requisitos previos](#requisitos-previos)
- [Primeros pasos](#primeros-pasos)
- [Variables de entorno](#variables-de-entorno)
  - [Parámetros generales](#parámetros-generales)
  - [Integración con Artifactory](#integración-con-artifactory)
  - [Integración con Jira](#integración-con-jira)
- [Scripts disponibles](#scripts-disponibles)
- [Consumir la API](#consumir-la-api)
- [Integrando Artifactory](#integrando-artifactory)
  - [Configurar el servidor](#configurar-el-servidor)
  - [Personalizar por petición](#personalizar-por-petición)
- [Integrando Jira](#integrando-jira)
  - [Configurar el servidor](#configurar-el-servidor-1)
  - [Personalizar por petición](#personalizar-por-petición-1)
- [Ejemplo completo de payload](#ejemplo-completo-de-payload)
- [Trazabilidad y monitoreo](#trazabilidad-y-monitoreo)
- [Solución de problemas](#solución-de-problemas)

---

## Resumen rápido

- Autenticación JWT HS256 y verificación HMAC opcional en operaciones de escritura.
- Middleware de seguridad: Helmet, CORS configurable, allowlist de IP y rate limiting.
- Ventana de cambios configurable con posibilidad de bypass controlado.
- Operaciones idempotentes `createCollection` y `createIndex`, con auditoría, revert y rollback en lotes.
- Documentación OpenAPI disponible en `/docs` (Swagger UI) y `/redoc`.
- Integraciones opcionales:
  - **Artifactory**: genera un artefacto JSON por operación.
  - **Jira**: crea o actualiza issues con comentarios operativos.

---

## Requisitos previos

- Node.js 18 o superior.
- Acceso a una instancia de MongoDB.
- (Opcional) Credenciales válidas para Artifactory y/o Jira si las integraciones se habilitan.

---

## Primeros pasos

1. Clona el repositorio y entra en la carpeta del proyecto.
2. Copia `.env.example` a `.env` y completa los valores necesarios.
3. Instala las dependencias:
   ```bash
   npm install
   ```
4. Ejecuta el proyecto en modo desarrollo:
   ```bash
   npm run dev
   ```
5. Abre `http://localhost:8080/docs` para navegar la especificación interactiva.

---

## Variables de entorno

### Parámetros generales

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto HTTP de la API (por defecto `8080`). |
| `AUDIT_DB` | Base de datos donde se guardan los registros de auditoría. |
| `JWT_SECRET` | Secreto HS256 para validar JWT (obligatorio si `JWT_REQUIRED=true`). |
| `HMAC_SECRET` | Clave para validar la firma HMAC de los cuerpos en escrituras. |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | Configuración del limitador global. |
| `IP_ALLOWLIST` | Lista (coma) de IP/CIDR permitidos. Vacío = sin restricción. |
| `CORS_ORIGINS` | Orígenes permitidos para CORS. Vacío = `*`. |
| `OPLOG_ENABLE`, `OPLOG_DIR` | Control de logs operativos (NDJSON diario). |
| `CHANGE_ALLOW_WINDOW` | Cadena que define ventana de cambios permitidos. |
| `CHANGE_FREEZE_MESSAGE` | Mensaje devuelto cuando la ventana bloquea la acción. |
| `CHANGE_BYPASS_TOKEN` | Token opcional para saltar la ventana de cambios. |
| `ALLOW_TARGET_URI_REGEX` | Regex opcional para validar URIs de destino. |

### Integración con Artifactory

| Variable | Descripción |
|----------|-------------|
| `ARTIFACTORY_ENABLED` | Activa la publicación (`true`/`false`). |
| `ARTIFACTORY_BASE_URL` | URL base (ej. `https://artifactory.miempresa.com/artifactory`). |
| `ARTIFACTORY_REPOSITORY` | Repositorio por defecto para los artefactos. |
| `ARTIFACTORY_PATH_TEMPLATE` | Plantilla de ruta (`changes/{changeId}/{action}-{timestamp}.json`). |
| `ARTIFACTORY_USERNAME`, `ARTIFACTORY_PASSWORD` | Credenciales básicas (alternativa al token). |
| `ARTIFACTORY_TOKEN` | Token API (`X-JFrog-Art-Api`). |
| `ARTIFACTORY_TIMEOUT_MS` | Timeout de la solicitud HTTP. |

### Integración con Jira

| Variable | Descripción |
|----------|-------------|
| `JIRA_ENABLED` | Activa la sincronización (`true`/`false`). |
| `JIRA_BASE_URL` | URL base de Jira (ej. `https://miempresa.atlassian.net`). |
| `JIRA_EMAIL` | Cuenta usada para autenticarse. |
| `JIRA_API_TOKEN` | Token API asociado a `JIRA_EMAIL`. |
| `JIRA_PROJECT_KEY` | Proyecto por defecto al crear issues. |
| `JIRA_ISSUE_TYPE` | Tipo de issue (por defecto `Task`). |
| `JIRA_DEFAULT_LABELS` | Etiquetas por defecto separadas por comas. |
| `JIRA_TIMEOUT_MS` | Timeout de la solicitud HTTP. |

> Consejo: reutiliza el bloque completo de `.env.example` para evitar errores tipográficos.

---

## Scripts disponibles

| Comando | Descripción |
|---------|-------------|
| `npm run dev` | Inicia el servidor con recarga en caliente (`ts-node-dev`). |
| `npm run build` | Compila TypeScript a JavaScript en `dist/`. |
| `npm start` | Ejecuta la versión compilada desde `dist/`. |

---

## Consumir la API

1. Genera un JWT firmado con `JWT_SECRET`. Puedes usar `jsonwebtoken`:
   ```bash
   npm i jsonwebtoken
   node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:'user-1',email:'dev@local'}, process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'1h'}));"
   ```
2. Para aplicar un cambio individual:
   ```bash
   curl -X POST "http://localhost:8080/changes/apply" \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
       "target": {
         "uri": "mongodb://user:pass@127.0.0.1:27017/admin",
         "database": "MyDB"
       },
       "operation": {
         "type": "createIndex",
         "collection": "users",
         "spec": { "email": 1 },
         "options": { "name": "ix_email_unique", "unique": true }
       }
     }'
   ```
3. Usa `/changes?uri=<URI codificada>` para consultar auditoría. Añade `status=applied,failed,skipped,reverted` si necesitas incluir revertidos.

Cuando `dryRun=true`, la API valida y genera plan, pero no toca MongoDB ni dispara integraciones.

---

## Integrando Artifactory

### Configurar el servidor

1. Establece `ARTIFACTORY_ENABLED=true` en `.env`.
2. Define `ARTIFACTORY_BASE_URL` y `ARTIFACTORY_REPOSITORY`.
3. Configura autenticación: usuario/contraseña o token API.
4. Reinicia el servicio para aplicar los cambios.

Para cada operación se genera un JSON con:

- Información del cambio original (incluyendo metadatos).
- Resultado (`status`, `message`, `durationMs`, `revertPlan`).
- Contexto operativo (`action`, `timestamp`, `requestId`, información de lote, actor`).

La respuesta HTTP incluye `integrations.artifactory` con el resultado de la publicación (`enabled`, `success`, `details`, `error`, `skippedReason`).

### Personalizar por petición

Dentro del payload, usa `metadata.artifactory`:

```json
"metadata": {
  "artifactory": {
    "repository": "db-changes",
    "path": "changes/{changeId}/{action}-{timestamp}.json",
    "properties": {
      "environment": "prod",
      "service": "payments-api"
    },
    "skip": false
  }
}
```

- La plantilla acepta `{changeId}`, `{action}`, `{timestamp}`, `{collection}` y `{operation}`.
- `properties` genera parámetros de matriz (`;clave=valor`).
- Usa `skip: true` si quieres omitir la publicación en un caso concreto.

---

## Integrando Jira

### Configurar el servidor

1. Establece `JIRA_ENABLED=true`.
2. Define `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `JIRA_EMAIL` y `JIRA_API_TOKEN`.
3. Ajusta `JIRA_ISSUE_TYPE` y `JIRA_DEFAULT_LABELS` si lo necesitas.
4. Reinicia el servicio.

Comportamiento por defecto:

- Si no se envía `metadata.jira.issueKey`, la API crea un nuevo issue usando los valores derivados del cambio.
- Cada ejecución agrega un comentario con `action`, `status`, `message` y `timestamp`.
- La respuesta incluye `integrations.jira` con `issueKey`, `created`, `commentId`, `url`, o en su defecto, `error` / `skippedReason`.

### Personalizar por petición

```json
"metadata": {
  "jira": {
    "issueKey": "OPS-1234",
    "summary": "Crear índice único para pagos",
    "description": "Detalles extendidos...",
    "labels": ["db-change", "payments"],
    "components": ["Payments"],
    "assignee": "db.automation",
    "skip": false
  }
}
```

- `issueKey` reutiliza un ticket existente.
- `summary` y `description` sobreescriben los generados.
- `labels`, `components` y `assignee` complementan o sustituyen la configuración global.
- `skip: true` evita que esa petición dispare Jira.
- `linkIssues` está reservado para futuras funciones.

---

## Ejemplo completo de payload

```json
{
  "target": {
    "uri": "mongodb://user:pass@cluster/?replicaSet=rs0&authSource=admin",
    "database": "Billing"
  },
  "operation": {
    "type": "createIndex",
    "collection": "payments",
    "spec": { "invoiceId": 1 },
    "options": { "name": "idx_invoice_unique", "unique": true }
  },
  "metadata": {
    "artifactory": {
      "repository": "db-changes",
      "path": "changes/{changeId}/{action}-{timestamp}.json",
      "properties": {
        "environment": "prod",
        "service": "payments-api"
      }
    },
    "jira": {
      "summary": "Crear índice único para pagos",
      "labels": ["db-change", "payments"],
      "components": ["Payments"],
      "assignee": "db.automation"
    }
  }
}
```

---

## Trazabilidad y monitoreo

- **Logs operativos**: si `OPLOG_ENABLE=true`, se generan archivos NDJSON diarios en `logs/ops-YYYYMMDD.log`.
- **Auditoría en MongoDB**: colección `cicd_changes_audit` con detalle de cada cambio y su `revertPlan`.
- **Respuesta del API**: el bloque `integrations` confirma qué ocurrió en Artifactory y Jira.

---

## Solución de problemas

| Problema | Acción sugerida |
|----------|-----------------|
| `401 Unauthorized` | Verifica el JWT (firmado con el secreto correcto y sin expirar). |
| `403` en `/changes/*` | IP fuera del allowlist, ventana de cambios cerrada o firma HMAC inválida. |
| `integrations.artifactory.skippedReason = "missing_credentials"` | Falta token/API key o usuario/contraseña en `.env`. |
| Errores `_failed_4xx/5xx` en Jira | Revisa permisos, datos obligatorios y proyecto configurado. |
| Integraciones omitidas en `dryRun` | Comportamiento esperado: no se contacta Artifactory/Jira durante simulaciones. |

---

¿Planeas integrarlo en un pipeline? Orquesta los JSON desde tu CI/CD y usa el resumen de integraciones para alimentar tableros operativos, reportes o alertas automáticas.
