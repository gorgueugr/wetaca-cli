# wetaca-cli spec

Estado: v0.1, 2026-10-29. Vocabulario en la sección 2. Los hechos de endpoints provienen del
bundle de la web de wetaca.com (SPA v49.6.0) y de pruebas en vivo de ese día. API no oficial, puede derivar.

## 1. Nombre

Binario `wetaca`. Paquete npm `wetaca-cli`, JavaScript (Node ≥ 18), cero dependencias.

## 2. Vocabulario

**Suscripción (SubscriptionAccount)**: tu cuenta de cliente recurrente, id `ModelId`. Tiene perfiles, dirección de entrega, franja y precio.

**Perfil (SubscriptionProfile)**: una persona dentro de la suscripción, con su propio menú, alérgenos y gustos.

**Sugerencia (Suggestion)**: la propuesta de pedido de una semana, identificada por `id` (ModelId). Es lo que se cobra si no se toca. `skip=true` significa semana saltada.

**Perfil-sugerencia (profileSuggestion)**: el menú de un perfil dentro de una Sugerencia. El que se edita con `suggestion edit`.

**Entrega (Delivery/Order)**: un pedido concreto, id numérico (`Int`), con `reference`, estado e `invoiceUrl`.

**Franja (option)**: ventana horaria de entrega (`start`, `end`, `price`).

**Sugerencia siguiente**: `nextSuggestion`, la semana próxima no cobrada. Es la que gestionan `suggestion *`.

## 3. Árbol de comandos

```
auth        login [--email E --password P | --token T [--clipboard]] | status | logout
me          show
subscription  show | pause [--weeks N] [--feedback S] | resume
suggestion  show | pause [--feedback S] | resume | edit --profile-suggestion ID --set "id:cant,..."
deliveries  next
orders      list [--limit N] [--offset N] | show <id> | cancel <id>
addresses   list | save --street C --number N [--floor F] --zipcode CP --city CIUDAD
            save crea la dirección y la asigna a la suscripción y a la semana próxima
            (flujo de la web: saveAddress → editDeliveryAccountInfo → editSuggestionDelivery);
            opcional --notes --firstname --lastname --phone; confirmación salvo --yes
vouchers    list
wallet      show
config      path | list | get <k> | set <k> <v>
doctor
skills      list | get wetaca-usage
completion  bash | zsh | fish
```

## 4. Flags globales

`--format json|jsonl|pretty` (env `WETACA_FORMAT`), `--error-format text|json` (env `WETACA_ERROR_FORMAT`),
`--profile NAME` (env `WETACA_PROFILE`), `--yes`, `--no-input` (env `WETACA_NO_INPUT=1`),
`--dry-run`, `--debug`, `--no-color`, `--help`, `--version`.

## 5. Contrato para agentes

- stdout: JSON (objeto por comando; `orders list` y `addresses list` devuelven array; `--format jsonl` emite una línea por item de las listas).
- stderr: avisos y errores. `--error-format json` → `{ error: { code, category, reason, retryable, message, suggested_commands, details? } }`.
- Exit codes: `0` ok · `1` inesperado · `2` uso/validación/confirmación denegada · `3` auth (login o token expirado) · `4` red · `5` no encontrado · `6` la API rechazó la operación (graphql_error/http_*) · `7` deriva de contrato (`contract_drift`, `null_field`).
- Confirmación: toda mutación con efectos reales muestra un resumen y pide `y/N`; sin TTY (o con `--no-input`) exige `--yes`. `--dry-run` (en `suggestion edit` y `orders cancel`) imprime el payload sin efectos.
- Guía embebida: `wetaca skills get wetaca-usage`.

## 6. Sesión

- Login con contraseña: `sessionTokenByPassword(username, password, segmentSlug)` → `{ customerId, jwtToken, requirePhoneNumber }`. Si `requirePhoneNumber`, se exige verificación SMS: hacer login en la web y usar `auth login --token <jwt>`.
- Importar token de sesión (vía recomendada para cuentas con Google): entra en wetaca.com con tu navegador, F12 → Network → filtra `api.wetaca.com` → cualquier petición → cabecera `authorization: Bearer <TOKEN>` → `wetaca auth login --token <TOKEN>` (o cópialo y usa `--clipboard`). El token no tiene por qué ser un JWT; se acepta cualquier formato y se valida con `tokenIsValid` antes de guardarse.
- Validación: `tokenIsValid(token)` (público).
- Almacenamiento: `config.json` → `profiles.<nombre>.token`. `WETACA_TOKEN` tiene prioridad (CI). Perfiles: `--profile` / `WETACA_PROFILE` / `defaultProfile`.
- Cabecera: `authorization: Bearer <jwt>` en cada petición.

## 7. API

- Endpoint: `POST https://api.wetaca.com/graphql` (Apollo Server, introspección desactivada), JSON `{query, variables}`. `WETACA_API_URL` la sobreescribe (tests).
- Tipos que usa el CLI: `ModelId` (string), `Int` (ids de pedido), `OrderProductMapGraph` (`{id, quantity}` en `productsInput`), `EditSuggestionDeliveryGraph` (aún no usado por el CLI).
- Drift: campo top-level `null` sin errores → exit 7. Error `UNAUTHENTICATED` → exit 3.

## 8. Operaciones usadas (v0.1)

| comando | operación |
|---|---|
| auth login | `sessionTokenByPassword`, `tokenIsValid` |
| auth status | `tokenIsValid`, `customer` |
| auth logout | `registerLogout` |
| me | `customer`, `subscriptionAccountByCustomer` (status), `walletBalance` |
| subscription show | `subscriptionAccountByCustomer` (full) + `nextSuggestion` |
| subscription pause | `cancelSubscriptionAccount(pausedWeeks)` |
| subscription resume | `activateSubscriptionAccount` |
| suggestion show | `nextSuggestion` (menús por perfil, pricing, delivery) |
| suggestion pause/resume | `pauseSuggestion` / `resumeSuggestion` |
| suggestion edit | `editProfileSuggestionProducts` |
| deliveries next | `nextSuggestions` + `nextDeliveries` + `nextPaymentPendingOrder` |
| orders list | `previousDeliveries(limit, offset)` |
| orders show | `order(id)` |
| orders cancel | `cancelConfirmedOrder(orderId)` |
| addresses list | `addresses` |
| vouchers list | `vouchers(limit, skipExpired, skipFuture)` |
| wallet show | `walletBalance` |

## 9. No soportado todavía (presente en la web, no en el CLI)

Pagos (Redsys/PayPal/GooglePay/ApplePay), cambiar método de pago, recargas de cartera programadas,
cambiar dirección/franja de entrega (`editSuggestionDelivery`, entrada `EditSuggestionDeliveryGraph`
sin validar), registro de cuentas nuevas con SMS, Google OAuth, encuesta semanal, referidos activos.

## 10. Limitaciones conocidas

- Los ids `productId`/`profileSuggestionId` son internos; se obtienen de `suggestion show`/`deliveries next`.
- El precio se devuelve en céntimos (campo `*Eur` ya formateado en algunas respuestas).
- `subscription pause` usa `cancelSubscriptionAccount` con `pausedWeeks`; la API lo trata como pausa temporal. Sin `--weeks` es pausa indefinida; reactivar con `subscription resume`.
