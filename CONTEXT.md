# Codex Provider Bridge

This context names the ownership rules for carrying Harness model requests through a locally authenticated Codex process without introducing a second agent runtime.

## Language

**Harness-owned request**:
A model request whose behavioral instructions, conversation history, tool catalog, and reconstructible context all originate from the Harness session.
_Avoid_: Wrapped Codex task, embedded Harness prompt

**Prompt ownership**:
The requirement that every client-controlled behavioral instruction visible to the model comes from the Harness system prompt.
_Avoid_: Prompt precedence, prompt override

**Codex transport**:
The locally authenticated Codex process used to carry a Harness-owned request to the selected model and return model events.
_Avoid_: Codex agent, child agent

**Harness tool handoff**:
The transfer of a model-requested tool call to the Harness agent loop, which owns execution, approval, logging, and presentation.
_Avoid_: Codex tool execution, tool proxying

**Codex-native action**:
A command, file change, search, MCP call, or other action owned and executed by the Codex runtime instead of Harness.
_Avoid_: Provider tool call

**Client instruction layer**:
The Codex instructions and configuration that a local integration can control before the request reaches OpenAI. OpenAI service-side policies are outside this layer.
_Avoid_: Entire model prompt, server prompt

**Layered Codex request**:
A model request that includes host-supplied instructions or tools together with Codex-owned client instructions, context, or tools.
_Avoid_: Harness-owned request, raw model request

**Instruction source report**:
The App Server list of discovered user or project instruction files. An empty report does not account for Codex-generated permission, environment, collaboration, or tool instructions.
_Avoid_: Complete prompt inventory
