# AgarMon

Juego de supervivencia inspirado en Agar.io, con masa y dinero separados. Esta primera versión implementa **el núcleo monetario**, sus reglas, persistencia y pruebas. No incluye todavía el juego visual, un servidor público ni depósitos o retiros reales.

## Ejecutar

Requiere Node.js 24 o superior. No usa dependencias externas.

```sh
npm test
npm run demo
```

La demo usa fondos simulados, el país ficticio `ZZ`, un reloj controlado y una base de datos en memoria. Nunca contacta una pasarela de pagos.

## Reglas económicas implementadas

| Entrada | Saldo inicial del jugador | Comisión de la casa | Doradas iniciales |
|---|---:|---:|---:|
| USD 10 | USD 5 | USD 2,50 | USD 2,50 |
| USD 50 | USD 25 | USD 12,50 | USD 12,50 |
| USD 100 | USD 50 | USD 25 | USD 25 |

- **Normal:** extracción desde 1:00 inclusive hasta 2:00 exclusive.
- **Hard:** sin extracción anticipada. Cada superviviente cobra su propio saldo cuando se agota el tiempo.
- **Eliminación completa:** el atacante recibe el 75% del saldo restante de la víctima; el resto reaparece como doradas.
- **Fin por tiempo:** los supervivientes reciben su saldo; las doradas sin recoger se asignan a la casa.
- La comisión inicial se reserva al iniciar y se reconoce como ingreso al liquidar.
- Cancelar una sala antes de empezar devuelve la entrada completa, sin comisión.
- Duración configurable. Los cinco minutos por defecto son una propuesta técnica provisional.
- Todo se expresa en centavos enteros de USD. Al dividir un saldo, el atacante recibe la parte redondeada hacia abajo y el mundo recibe el resto exacto.
- La masa no representa dólares y no se implementa en este módulo.

La extracción acredita la billetera del jugador. El retiro hacia un banco o proveedor es una operación distinta.

## Qué funciona

- Diario de movimientos con origen, destino y monto; las sumas siempre cuadran.
- Depósitos confirmados deduplicados por proveedor e ID de pago, incluyendo notificaciones repetidas.
- Entrada reservada, saldo de partida, dinero del mundo y comisión registrados por separado.
- Repetir una operación devuelve su resultado anterior; cambiar el monto, destinatario o destino de retiro con la misma clave se rechaza.
- SQLite con transacciones `BEGIN IMMEDIATE`, WAL y sincronización completa; movimientos protegidos de actualización/borrado por triggers.
- Dos trabajadores no pueden reservar más dinero que el saldo disponible.
- Los saldos, retiros pendientes y claves de repetición sobreviven al reinicio usando una ruta de archivo.
- Un retiro incierto mantiene el dinero reservado hasta confirmar si se pagó o falló.
- Ningún país habilitado por defecto. Uruguay se rechaza explícitamente tanto por residencia como por ubicación informada por el servicio confiable de identidad/localización.

## Persistencia

```js
import { MoneyEngine } from './src/monetary-engine.mjs';

const engine = new MoneyEngine({ databasePath: './data/agarmon.sqlite' });
console.log(engine.audit());
engine.close();
```

Los datos de identidad, edad y localización deben provenir de servicios independientes verificados. Este código recibe afirmaciones del servidor: **no implementa KYC ni una geolocalización real**. Nunca se deben permitir estos comandos directamente desde el navegador.

## Validación

El 30 de septiembre de 2026 se ejecutaron en Node.js 24.19.0:

- **32 pruebas aprobadas**, sin fallos.
- **500 partidas simuladas** con movimientos aleatorios deterministas.
- Reinicio y recuperación de una partida y un retiro pendiente.
- Dos trabajadores simultáneos contra la misma base de datos.
- La demo contable: USD 20 ingresados, USD 8,75 para el jugador y USD 11,25 para la casa.

GitHub Actions ejecuta las pruebas y la demo en cada push y pull request.

## Antes de usar dinero real

Esta versión es una base de desarrollo, no una billetera lista para producción. Faltan:

1. Autenticación, API privada del servidor de juego y verificación real de colisiones.
2. Mercados habilitados y requisitos del país donde opere la empresa; bloquear jugadores de Uruguay no sustituye esa revisión.
3. Un proveedor que admita expresamente este modelo y una cuenta comercial aprobada. Stripe incluye competencias de habilidad con premios monetarios entre sus negocios prohibidos: https://stripe.com/legal/restricted-businesses
4. Integración de depósitos y retiros: firmas de notificaciones, verificación de moneda/monto/destino, conciliación con el proveedor y envío idempotente mediante una bandeja de operaciones pendientes.
5. KYC, edad, ubicación real y controles de fraude, límites y contracargos.
6. Política de cancelación de partidas ya iniciadas, particularmente cuando hubo extracciones.
7. Tratamiento del dinero al dividir células y recibir ataques parciales. Hoy el saldo es por jugador y la eliminación corresponde a la derrota completa.
8. Copias de seguridad, restauración y operación en producción. El estado agregado de SQLite prioriza corrección y sencillez, no el rendimiento de una plataforma masiva.

El saldo de la casa en el diario es ingreso contable bruto; no representa una transferencia bancaria automática ni ganancia neta después de gastos e impuestos.

Ver [el diseño monetario](docs/monetary-design.md).
