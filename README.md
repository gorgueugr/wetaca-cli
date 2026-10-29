# wetaca-cli

Gestiona tu **Wetaca** desde el terminal: suscripción, menú semanal, entregas y pedidos. Diseñado para personas **y para agentes IA**.

```
wetaca suggestion show --format pretty
```

```
id: 68f21a...
skip: false
validUntil: Jue 30 oct 23:59
week: { week: 45, year: 2026 }
pricingEur: { toPay: 42,30 €, shipping: 0,00 € }
profiles: 2 (Jorge, Ana)
```

- **Todo lo que haces en la web**: ver el menú de la semana próxima por perfil, cambiar tuppers, saltar una semana, pausar la suscripción, ver entregas pasadas, cancelar un pedido, vouchers y cartera.
- **Hecho para scripts y agentes IA**: JSON por defecto, exit codes estables, envoltorio de errores JSON, `--dry-run`, y guía de uso embebida (`wetaca skills get wetaca-usage`).
- Un solo paquete Node sin dependencias. Requiere Node ≥ 18.

## Instalar

```
npm install -g .          # desde este repo
wetaca doctor
```

## Empezar

```
wetaca auth login --refresh-token <COOKIE>   # cookie refresh-token de wetaca.com (dura ~120 días)
wetaca auth login               # pide el refresh-token por prompt (oculto); también acepta un JWT de sesión
wetaca me --format pretty
```

La sesión se guarda en `%USERPROFILE%\.config\wetaca-cli\config.json` (o `$XDG_CONFIG_HOME/wetaca-cli`), cifrado no, permisos de usuario; se puede sobreescribir con `WETACA_TOKEN` (útil en CI).

## Quickstart

```
# ¿qué toca esta semana?
wetaca suggestion show --format pretty

# saltar la semana próxima (pide confirmación)
wetaca suggestion pause

# cambiar tuppers del menú (dry-run primero, luego --yes)
wetaca suggestion edit --profile-suggestion ID --set "productId:2,productIdB:1" --dry-run
wetaca suggestion edit --profile-suggestion ID --set "productId:2,productIdB:1" --yes

# pausar vacaciones
wetaca subscription pause --weeks 2 --yes
wetaca subscription resume

# pedidos
wetaca deliveries next
wetaca orders cancel 12345 --dry-run
wetaca orders cancel 12345 --yes

# para agentes IA
wetaca skills get wetaca-usage
```

## Documentación

| doc | |
|---|---|
| [Especificación](docs/cli-spec.md) | cada comando, flag, exit code y operación GraphQL |
| [Operaciones extraídas](docs/api-operations/) | los ~190 documentos GraphQL de la web de Wetaca |
| [Guía para agentes](docs/agent-guide.md) | `wetaca skills get wetaca-usage` |

## Bueno saber

- **No oficial.** Usa la API GraphQL de `api.wetaca.com` (la misma que la web y la app). Wetaca puede cambiarla; si lo hace, el CLI termina con exit 7 (`contract_drift`).
- **Tu login se queda local.** El JWT se guarda en tu disco y solo viaja hacia Wetaca.
- **Nada sin confirmación.** Las operaciones con efectos reales (`suggestion pause/edit`, `subscription pause`, `orders cancel`) muestran un resumen y piden confirmación; sin terminal exigen `--yes`.
- **No toca pagos.** Las tarjetas y pagos pendientes se gestionan en wetaca.com.
- Sé amable: este CLI hace pocas peticiones, una por comando.

## Licencia

MIT.
