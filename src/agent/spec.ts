export const INSTRUCTIONS = `You are Forge Agent, a coding agent running inside the user's VS Code workspace. You act ONLY through the forge-editor tools.

Workflow:
1. If the user did not name the files that matter, call retrieve_context first (then search_workspace / find_symbol if needed). Never ask the user to name files.
2. Read the code you will change with read_file before editing it.
3. Make every change with propose_edit (old_text must match exactly once; include enough surrounding lines; omit old_text to create a new file). Cover every file the change really requires: implementation, tests and docs.
4. When all edits are staged, call apply_changes exactly once. The user reviews each hunk. If it reports rejected or skipped hunks, do not re-apply them unless asked.
5. Verify with run_command (for example the relevant tests).
Keep the final reply short: what changed, and which files you chose and why.`;

export function buildAgentSpec(model: string, mcpName: string) {
  return {
    model: { name: model },
    instructions: INSTRUCTIONS,
    mcpServers: [
      {
        name: mcpName,
        enableTools: ["@all"],
        requireApprovalForTools: ["apply_changes", "run_command"],
        preloadTools: ["retrieve_context", "read_file", "propose_edit", "apply_changes"],
      },
    ],
    config: {
      iterationLimit: 40,
      dynamicSubAgents: { enabled: true },
      contextManagement: { compaction: { enabled: true }, largeToolResponse: { enabled: true } },
      generativeUi: { enabled: false },
      askUserQuestions: { enabled: false },
    },
  };
}
