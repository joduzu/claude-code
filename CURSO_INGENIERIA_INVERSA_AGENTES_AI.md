# Curso: Ingenieria Inversa de Agentes AI

## Basado en el repositorio `ultraworkers/claw-code`

**Duracion estimada**: 12 semanas (2 sesiones/semana)
**Nivel**: Intermedio-Avanzado
**Prerrequisitos**: Programacion en Python, nociones basicas de Rust, familiaridad con CLI y git

---

## Objetivos del curso

1. Comprender la arquitectura interna de un agente AI de terminal a nivel de produccion
2. Dominar patrones de diseno para orquestacion de herramientas, gestion de estado y construccion de prompts
3. Desarrollar capacidad de analisis arquitectonico mediante ingenieria inversa de codigo real
4. Construir un mini-agente funcional aplicando los patrones aprendidos

---

## Modulo 0 — Fundamentos y contexto (Semana 1)

### Sesion 0.1: Que es un agente AI de terminal

- Diferencia entre chatbot, asistente y agente
- Anatomia de un agente: runtime, tools, prompts, session state
- El ecosistema actual: Claude Code, Codex CLI, Aider, Cursor
- Caso de estudio: por que claw-code es util como material educativo

**Ejercicio**: Instalar y usar Claude Code o un agente similar; documentar las herramientas que se invocan durante una sesion tipica.

### Sesion 0.2: Metodologia de ingenieria inversa de software

- Analisis top-down vs bottom-up
- Lectura de arboles de dependencias (Cargo.toml, imports Python)
- Tecnicas: call graph, data flow, grep arqueologico
- Herramientas: `cargo tree`, `ast` module de Python, `ripgrep`

**Ejercicio**: Clonar `ultraworkers/claw-code`, generar el arbol de dependencias de Rust (`cargo tree`) y dibujar un diagrama de alto nivel de las relaciones entre crates.

---

## Modulo 1 — Capa de API y comunicacion con LLMs (Semanas 2-3)

### Sesion 1.1: Abstraccion de proveedores (`rust/crates/api-client`)

- Patron Provider/Adapter para multiples backends de LLM
- Autenticacion: OAuth flow, API keys, token refresh
- Streaming de respuestas: SSE, chunked transfer, backpressure

**Archivos clave a estudiar**:
```
rust/crates/api-client/
  src/
    provider.rs      — trait de abstraccion
    streaming.rs     — manejo de chunks SSE
    auth.rs          — flujo OAuth
```

**Ejercicio**: Identificar el trait principal del provider. Documentar que metodos expone y como se implementa para al menos 2 proveedores distintos.

### Sesion 1.2: Construccion y gestion de mensajes

- Formato de mensajes: roles, tool_use, tool_result
- Compactacion de contexto: cuando y como se comprime el historial
- Token counting y estrategias de truncamiento

**Ejercicio**: Rastrear el flujo completo de un mensaje desde input del usuario hasta la llamada API. Crear un diagrama de secuencia.

---

## Modulo 2 — Runtime y bucle principal (Semanas 4-5)

### Sesion 2.1: El runtime loop (`rust/crates/runtime`)

- Patron agent loop: read → think → act → observe
- Gestion de sesion: estado, persistencia, recovery
- Compactacion de historial y memory management

**Archivos clave a estudiar**:
```
rust/crates/runtime/
  src/
    session.rs       — estado de sesion
    loop.rs          — bucle principal del agente
    compaction.rs    — compresion de historial
    prompt.rs        — construccion del system prompt
```

**Ejercicio**: Mapear el bucle principal del runtime. Identificar: (a) donde se decide si invocar una herramienta o responder al usuario, (b) como se maneja el estado entre turnos.

### Sesion 2.2: Construccion del system prompt

- Anatomia del system prompt: instrucciones base, herramientas, contexto del proyecto
- Inyeccion dinamica: system reminders, CLAUDE.md, reglas de permisos
- Como el prompt cambia segun el estado de la sesion

**Ejercicio**: Localizar en `src/context.py` y en el crate `runtime` como se ensambla el prompt. Listar todas las fuentes de datos que contribuyen al prompt final. Comparar la version Python con la Rust.

---

## Modulo 3 — Sistema de herramientas (Semanas 6-7)

### Sesion 3.1: Manifest y registro de tools (`rust/crates/tools`)

- Tool schema: nombre, descripcion, parametros JSON Schema
- Registro dinamico: como el agente sabe que herramientas tiene
- Deferred tools: carga lazy de herramientas pesadas

**Archivos clave a estudiar**:
```
rust/crates/tools/
  src/
    manifest.rs      — definiciones de herramientas
    executor.rs      — ejecucion de herramientas
    sandbox.rs       — aislamiento de ejecucion
```

```python
# Python equivalente
src/tools.py         — metadatos de herramientas
src/Tool.py          — clase base
src/tool_pool.py     — pool de recursos
```

**Ejercicio**: Catalogar TODAS las herramientas built-in (Read, Write, Edit, Bash, Glob, Grep, etc.). Para cada una, documentar: parametros, valor de retorno, y restricciones de permisos.

### Sesion 3.2: Ejecucion y sandboxing

- Como se ejecuta una tool call: parsing → validacion → ejecucion → formateo de resultado
- Sandboxing de Bash: restricciones de seguridad, timeouts
- Permisos: auto-allow, user-prompt, deny
- Patron de tool result: exito, error, truncamiento

**Ejercicio**: Implementar una herramienta custom siguiendo el patron del manifest. Debe registrarse dinamicamente y ser invocable por el agente.

---

## Modulo 4 — Comandos, skills y plugins (Semana 8)

### Sesion 4.1: Slash commands y skills (`rust/crates/commands`)

- Diferencia entre tool (invocada por el LLM) y command (invocado por el usuario)
- Discovery de skills: como se cargan y resuelven
- Patron de expansion: de `/commit` a un prompt completo

**Archivos clave**:
```
rust/crates/commands/
  src/
    registry.rs      — registro de comandos
    skills.rs        — descubrimiento de skills
    config.rs        — inspeccion de configuracion
```

```python
src/commands.py
src/skills/
```

**Ejercicio**: Trazar el ciclo de vida completo de `/commit`: desde que el usuario lo teclea hasta que se ejecuta el commit. Identificar cada transformacion del input.

### Sesion 4.2: Sistema de plugins y hooks (`rust/crates/plugins`)

- Arquitectura de plugins: discovery, carga, lifecycle
- Hook pipeline: PreToolUse, PostToolUse, SessionStart, etc.
- Plugins bundled vs plugins de usuario
- Patron de intercepcion: como un hook puede modificar o bloquear una accion

**Ejercicio**: Escribir un plugin que registre en un log cada herramienta invocada durante una sesion, con timestamps y duracion.

---

## Modulo 5 — Subsistemas auxiliares (Semana 9)

### Sesion 5.1: LSP, servidor HTTP y compatibilidad

- Integracion con editores via LSP (`rust/crates/lsp`)
- Servidor SSE para interfaces web (`rust/crates/server`, basado en Axum)
- Capa de compatibilidad (`rust/crates/compat-harness`)

**Ejercicio**: Analizar como el servidor SSE expone las mismas capacidades que la CLI. Identificar los endpoints y el protocolo de comunicacion.

### Sesion 5.2: Estado, permisos y costes

- Gestion de permisos: modelo de confianza, escalacion
- Cost tracking: como se contabilizan tokens y costes
- Session store: persistencia entre invocaciones

**Archivos clave**:
```python
src/permissions.py
src/cost_tracker.py
src/costHook.py
src/session_store.py
src/history.py
```

**Ejercicio**: Reconstruir el modelo de permisos completo. Crear un diagrama de decision que muestre cuando una herramienta se ejecuta automaticamente vs cuando pide confirmacion.

---

## Modulo 6 — MCP: Model Context Protocol (Semana 10)

### Sesion 6.1: Fundamentos del protocolo MCP

- Que es MCP y por que existe
- Arquitectura: host, client, server
- Transporte: stdio, SSE, HTTP streamable
- Primitivas: tools, resources, prompts, sampling

**Ejercicio**: Leer la especificacion MCP y mapear como claw-code implementa cada primitiva en el crate `runtime`.

### Sesion 6.2: Orquestacion MCP en el runtime

- Como el agente descubre y conecta servidores MCP
- Registro dinamico de herramientas MCP
- Manejo de errores y reconexion
- Implicaciones de seguridad

**Ejercicio**: Configurar un servidor MCP minimo (por ejemplo, un filesystem server) y analizar la secuencia de mensajes entre el runtime y el servidor.

---

## Modulo 7 — Analisis comparativo y parity (Semana 11)

### Sesion 7.1: Python vs Rust — decisiones arquitectonicas

- Que se gana y que se pierde en cada implementacion
- Analisis de `PARITY.md`: que esta portado y que falta
- Patrones idiomaticos: traits vs clases, ownership vs GC, async en ambos mundos

**Archivos clave**:
```
PARITY.md
src/parity_audit.py
tests/
```

**Ejercicio**: Elegir un subsistema (ej: tool execution). Comparar linea a linea la implementacion Python y Rust. Documentar: (a) diferencias semanticas, (b) trade-offs de rendimiento, (c) bugs potenciales en la traduccion.

### Sesion 7.2: Testing y verificacion de parity

- Estrategias de testing para un port: regression, snapshot, fuzzing
- Suite de verificacion del repo
- Como garantizar equivalencia funcional entre implementaciones

**Ejercicio**: Escribir tests de parity para un modulo que aun no los tenga. Ejecutarlos contra ambas implementaciones.

---

## Modulo 8 — Proyecto final (Semana 12)

### Opcion A: Mini-agente CLI

Construir un agente de terminal funcional que incluya:
- [ ] Runtime loop con al menos 3 herramientas (Read, Write, Bash)
- [ ] System prompt dinamico con inyeccion de contexto
- [ ] Sistema de permisos basico
- [ ] Streaming de respuestas
- [ ] Al menos 1 slash command

### Opcion B: Informe de ingenieria inversa

Producir un documento tecnico que cubra:
- [ ] Diagrama completo de la arquitectura (nivel de componentes)
- [ ] Analisis detallado de 2 subsistemas a nivel de codigo
- [ ] Identificacion de al menos 3 patrones de diseno con ejemplos
- [ ] Evaluacion critica: fortalezas, debilidades, posibles mejoras
- [ ] Comparativa con otro agente open source (ej: Aider, OpenHands)

### Opcion C: Contribucion al repo

- [ ] Portar un modulo faltante de Python a Rust (o viceversa)
- [ ] Agregar tests de parity
- [ ] Documentar un subsistema no documentado
- [ ] Pull request aceptado al repositorio

---

## Recursos complementarios

### Lecturas
- Especificacion MCP: https://modelcontextprotocol.io
- Documentacion de Claude Code (referencia de la herramienta original)
- "Building Effective Agents" — Anthropic research blog
- The Rust Programming Language (book) — para refuerzo de Rust

### Herramientas necesarias
- Rust toolchain (`rustup`, `cargo`)
- Python 3.11+
- `ripgrep` (busqueda en codigo)
- Un agente AI funcional (Claude Code, Codex CLI, etc.) para comparacion practica
- Graphviz o Mermaid para diagramas

### Metodologia de evaluacion

| Componente | Peso |
|---|---|
| Ejercicios semanales | 40% |
| Participacion y code reviews entre pares | 15% |
| Presentacion de subsistema (semana 6) | 15% |
| Proyecto final | 30% |

---

## Nota etica

Este curso utiliza claw-code como material de estudio arquitectonico. El objetivo es aprender patrones de diseno, no replicar o redistribuir codigo propietario. Los estudiantes deben:

1. No utilizar el codigo analizado en productos comerciales sin verificar la licencia
2. Respetar la propiedad intelectual de los autores originales
3. Enfocarse en los **patrones y principios**, no en la copia literal
4. Contribuir de vuelta a la comunidad open source cuando sea posible
