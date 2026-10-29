// Guía de uso para agentes IA, embebida en el CLI (wetaca skills get wetaca-usage).
export const GUIDE = `# wetaca-cli — guía para agentes IA

Gestiona la cuenta de Wetaca (suscripción de comida semanal) del usuario desde el terminal.
Todo comando devuelve JSON en stdout por defecto; los errores van a stderr.

## Antes de empezar

1. Ejecuta \`wetaca doctor\` para verificar node, conectividad y sesión.
2. \`wetaca auth status\` dice si hay sesión válida. Si no la hay:
   - \`wetaca auth login\` (email + contraseña, por prompt)
   - \`wetaca auth login --token T\` o \`--token --clipboard\`: token copiado de la cabecera
     \`authorization: Bearer …\` de cualquier petición a api.wetaca.com en las DevTools del
     usuario (F12 → Network). Es la vía si su cuenta entra con Google.
   No pidas al usuario la contraseña de Google ni automatices su navegador para el login.

## Contrato de salida

- stdout: JSON (\`--format pretty\` para humanos, \`jsonl\` para listas línea a línea).
- \`--error-format json\`: envoltorio de error { error: { code, category, reason, retryable, message, suggested_commands } }.
- Exit codes estables: 0 ok · 1 inesperado · 2 uso/validación/confirmación denegada · 3 auth ·
  4 red · 5 no encontrado · 6 la API rechazó la operación · 7 deriva de contrato (schema cambiado).
- \`reason: "auth_required"\` → nada que reintentar; el usuario debe hacer login.
- \`reason: "contract_drift"\` → no reinventes la query; abre issue en el repo.

## Reglas para operaciones con efectos reales

1. Nada cambia la cuenta sin confirmación: sin terminal, exige \`--yes\`. Pasa \`--yes\` SOLO cuando
   el usuario pidió exactamente esa operación y vio el resumen.
2. Usa \`--dry-run\` en \`suggestion edit\` y \`orders cancel\` para mostrar qué se enviaría, antes de pedir confirmación.
3. \`suggestion pause\` salta la entrega de la semana próxima (la semana ya cobrada NO se toca).
   \`subscription pause --weeks N\` pausa la suscripción N semanas (cancelación temporal);
   \`subscription resume\` la reactiva.
4. \`orders cancel <id>\` cancela un pedido confirmado y devuelve el importe. Ids: \`deliveries next\`
   (pedidos pendientes) y \`orders list\` (histórico).
5. Nunca gestiones pagos: wetaca-cli no toca tarjetas ni pagos pendientes de Redsys/PayPal.
   Si \`nextPaymentPendingOrder\` no es null, dilo al usuario y que lo pague en wetaca.com.

## Comandos

  wetaca auth login [--email E --password P | --token T] | status | logout
  wetaca me                          resumen: cliente + suscripción + cartera
  wetaca subscription show | pause [--weeks N] [--feedback S] | resume
  wetaca suggestion show             menú de la semana próxima por perfil, precios, ventana de entrega
  wetaca suggestion pause | resume   saltar / reactivar la semana próxima
  wetaca suggestion edit --profile-suggestion ID --set "productId:cant,..." [--dry-run]
  wetaca deliveries next             sugerencias y pedidos pendientes (ids para orders/cancel)
  wetaca orders list [--limit N] | show <id> | cancel <id> [--dry-run]
  wetaca addresses list
  wetaca vouchers list
  wetaca wallet
  wetaca config path | list | get <k> | set <k> <v>
  wetaca doctor
  wetaca skills get wetaca-usage     esta guía

## Flujos típicos

- "¿Qué toca esta semana?": \`wetaca suggestion show --format pretty\`
- "Esta semana no quiero arroz": \`suggestion show\` → localiza el plato y su \`productSuggestionId\`
  (\`profileSuggestionId\`) y \`productId\` → \`suggestion edit --profile-suggestion ID --set "..." --dry-run\`
  → muestra el plan → confirma → ejecuta con \`--yes\`.
- "Vacaciones dos semanas": \`subscription pause --weeks 2\` (resumen → --yes) y luego \`subscription resume\`.
- "Cancela el pedido de mañana": \`deliveries next\` → \`orders cancel <id>\`.
`;
