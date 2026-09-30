# Diseño monetario v0.1

## Alcance

Módulo privado invocado por un servidor confiable. Las funciones no son rutas HTTP públicas. No existe un proveedor de pagos conectado y los ejemplos representan fondos ficticios.

Cada operación usa centavos de USD. En el mundo existen dos recursos separados: masa sin valor monetario y doradas respaldadas por el saldo del mundo. Las pruebas abarcan únicamente el recurso monetario.

## Cuentas

| Cuenta | Función |
|---|---|
| `provider:clearing` | Contrapartida contable de los fondos confirmados por el proveedor |
| `wallet:<usuario>` | Saldo disponible de un usuario |
| `match:<partida>:entry:<usuario>` | Entrada reservada antes de iniciar |
| `match:<partida>:active:<usuario>` | Saldo arriesgado en una partida |
| `match:<partida>:world` | Respaldo exacto de las doradas existentes |
| `match:<partida>:pending_fee` | Comisión reservada pendiente de reconocer |
| `house:fees` | Comisiones liquidadas |
| `house:uncollected` | Doradas no recogidas al terminar |
| `payout:<retiro>` | Saldo reservado para un retiro externo |

La suma de las cuentas es cero gracias a la contrapartida del proveedor. Ningún saldo de usuario, partida, casa o retiro puede ser negativo. Esta comprobación valida el registro contable; no demuestra por sí sola que exista dinero real en una cuenta bancaria. Esa comprobación requiere conciliación independiente con el proveedor.

## Transacciones e idempotencia

SQLite guarda el estado del motor, el diario de movimientos y una copia de los saldos por cuenta. Cada escritura:

1. Obtiene el bloqueo de escritura mediante `BEGIN IMMEDIATE`.
2. Lee el estado confirmado más reciente, incluyendo operaciones ejecutadas por otro proceso.
3. Busca la clave de la operación y su huella de parámetros.
4. Ejecuta la regla, valida saldos, respaldo de doradas y diario.
5. Persiste el estado, los nuevos movimientos y los saldos en la misma transacción.
6. Confirma todo, o revierte todo si ocurre un error.

La misma clave con los mismos parámetros devuelve el resultado original, incluso tras reiniciar. La misma clave con datos distintos se rechaza. Un depósito utiliza como identidad el pago del proveedor, no el ID de una notificación, porque un mismo pago puede generar múltiples notificaciones.

El diario incluye una secuencia y sus filas tienen protección contra cambios y borrados. Los triggers no protegen frente a un administrador que controle íntegramente el archivo; una auditoría de producción necesita controles de acceso, respaldos y supervisión independiente.

El modelo persiste un agregado completo y comprueba copias contables. Es apropiado para esta primera implementación y sus pruebas; antes de escalar conviene normalizar las entidades y reducir la granularidad de los bloqueos con una base de datos adecuada al despliegue.

## Reglas temporales

El reloj es del servidor, no del navegador. Los jugadores entran a una sala antes de empezar y comparten el inicio. No se admite ingresar una vez empezada.

- Normal: extracción cuando `60 000 <= tiempo_transcurrido < 120 000` ms.
- Hard: no se admite extracción anticipada.
- Al llegar a `endsAt` no se admiten recolecciones, eliminaciones ni extracciones nuevas; se liquida la partida.
- La duración se guarda dentro de cada partida, por lo que cambiar la configuración de otro proceso no modifica una partida existente.
- Las operaciones repetidas confirmadas antes del vencimiento mantienen su resultado original.

La extracción es inmediata en v0.1. Un eventual tiempo de espera vulnerable para extraerse es una mecánica pendiente, no una decisión económica implementada.

## Retiro externo

`reserveWithdrawal` vincula usuario, monto y referencia del destino, y mueve fondos de la billetera a una cuenta reservada. Repetir la petición no vuelve a descontar. No envía un pago.

Un adaptador futuro debe enviar al proveedor una operación con una clave de idempotencia estable y validar el destino autorizado para el usuario. Si el resultado es incierto, `markWithdrawalUnknown` deja la reserva intacta. Un resultado final verificado:

- `paid`: libera la reserva hacia la contrapartida del proveedor.
- `failed`: devuelve la reserva a la billetera.

Nunca se interpreta un timeout como un fallo definitivo. No se paga desde una notificación del navegador. Una restricción para apostar no confisca automáticamente fondos previamente retenidos; el retorno de fondos requiere sus propios controles de identidad y del proveedor.

## Decisiones aún pendientes

- Número de jugadores, duración definitiva, masa y tamaño del mapa.
- Saldo por célula al dividirse y tratamiento de ataques parciales.
- Cancelación de una partida activa: devolver entradas después de redistribuciones/extracciones exige una regla explícita y fondos de respaldo. El motor sólo admite cancelación previa al inicio.
- Comisiones externas, impuestos, disputas y contracargos.
- Protección contra alianzas y transferencias coordinadas mediante eliminaciones.
- Proveedor y jurisdicciones autorizadas; las cuentas financieras no se habilitan públicamente con esta versión.

## Interfaces del núcleo

- Identidad confiable: `registerUser`, `updateEligibility`.
- Depósitos verificados: `creditSettledDeposit`.
- Partidas: `createMatch`, `join`, `start`, `collect`, `eliminate`, `extract`, `finish`, `cancelLobby`.
- Retiros: `reserveWithdrawal`, `markWithdrawalUnknown`, `resolveWithdrawal`.
- Inspección: `snapshot`, `balance`, `audit`, `close`.

Estas interfaces separan las reglas financieras de la futura presentación y del motor físico del juego. El navegador no debe poder ordenar una eliminación, acreditar un depósito, cambiar su edad/país o confirmar un retiro.
