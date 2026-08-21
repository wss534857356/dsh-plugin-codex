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

**Codex action report**:
A logged `codex-action` block that names its semantic category, lifecycle phase, exact App Server protocol event, input, and available outcome. It is provider trajectory, not a request for Harness tool execution.
_Avoid_: Harness tool call, tool result

**Codex-owned context**:
A model-visible message added by Codex after Harness history injection. It is logged and displayed as provider context, but it is not replayed as Harness-authored history on the next stateless request.
_Avoid_: Harness context, assistant response

**Codex provider lifecycle**:
An App Server setup or thread event such as the result of `thread/start`. It discloses provider state but does not claim that the model performed an action.
_Avoid_: Codex-native action, Harness tool call

**Raw Codex action item**:
A non-message Responses item reported by `rawResponseItem/completed`, including Code Mode `custom_tool_call` and its output, that may have no corresponding App Server `ThreadItem` lifecycle.
_Avoid_: Unparsed replay state, Harness tool call

**Client instruction layer**:
The Codex instructions and configuration that a local integration can control before the request reaches OpenAI. OpenAI service-side policies are outside this layer.
_Avoid_: Entire model prompt, server prompt

**Layered Codex request**:
A model request that includes host-supplied instructions or tools together with Codex-owned client instructions, context, or tools.
_Avoid_: Harness-owned request, raw model request

**Harness control ownership**:
Harness authority over durable history, Harness tool execution, session logging, and user-visible trajectory without claiming exclusive ownership of the model-visible prompt or tool catalog.
_Avoid_: Prompt ownership, raw transport

**Instruction source report**:
The App Server list of discovered user or project instruction files. An empty report does not account for Codex-generated permission, environment, collaboration, or tool instructions.
_Avoid_: Complete prompt inventory

**Provider-following auxiliary call**:
An auxiliary operation that inherits the initiating Agent's selected provider and model instead of using a deployment-wide fallback route.
_Avoid_: Main model turn, static auxiliary provider

**Conditional tool takeover**:
An around-dispatch decision that handles a Harness tool only for a matching initiating provider and otherwise delegates to the tool's existing execution chain unchanged.
_Avoid_: Tool replacement, profile-wide provider switch
