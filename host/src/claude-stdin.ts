export function encodeClaudeUserMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
  })}\n`;
}

export function encodeClaudeControlAllow(requestId: string): string {
  return `${JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { behavior: "allow", updatedInput: null },
    },
  })}\n`;
}
