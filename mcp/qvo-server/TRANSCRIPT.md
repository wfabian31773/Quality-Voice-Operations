# QVO MCP server: inspector transcript

Recorded over the in-memory MCP transport (real SDK `Client` ↔ QVO `Server`) with fixture data:
no database, no network. `→` is client to server, `←` is server to client. The `initialize`
handshake is omitted.

Key: `env:admin-a` (scopes `qvo:read`, `qvo:admin`), bound to tenant `tenant-a`.
The registry is the PR-01 echo fixtures plus the `qvo.*` helpers, because no app action sets
`permissions.mcpScope` yet.

Regenerate with `npm run test -- mcp/qvo-server -u` (the file is a vitest file snapshot).

### 1. tools/list

```text
→ {
  "method": "tools/list",
  "jsonrpc": "2.0",
  "id": 1
}
← {
  "result": {
    "tools": [
      {
        "name": "core_echo_commit",
        "description": "Commit an echo confirmation. Fixture used only in tests.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "confirmationToken": {
              "type": "string",
              "format": "uuid"
            },
            "payloadHash": {
              "type": "string"
            },
            "dryRun": {
              "type": "boolean",
              "default": true,
              "description": "Defaults to true: validate and audit only. Pass false to actually run the write."
            },
            "idempotencyKey": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "description": "Required when dryRun is false. Same key + same input replays the stored result."
            }
          },
          "required": [
            "confirmationToken",
            "payloadHash"
          ],
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": false,
          "destructiveHint": true,
          "openWorldHint": false
        }
      },
      {
        "name": "core_echo_prepare",
        "description": "Prepare an echo confirmation. Fixture used only in tests.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "message": {
              "type": "string",
              "minLength": 1
            },
            "phone": {
              "type": "string"
            },
            "dryRun": {
              "type": "boolean",
              "default": true,
              "description": "Defaults to true: validate and audit only. Pass false to actually run the write."
            },
            "idempotencyKey": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "description": "Required when dryRun is false. Same key + same input replays the stored result."
            }
          },
          "required": [
            "message"
          ],
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": false,
          "destructiveHint": false,
          "openWorldHint": false
        }
      },
      {
        "name": "core_echo_read",
        "description": "Echo a message. Fixture used only in tests.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "message": {
              "type": "string",
              "minLength": 1
            },
            "phone": {
              "type": "string"
            }
          },
          "required": [
            "message"
          ],
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": true,
          "destructiveHint": false,
          "openWorldHint": false
        }
      },
      {
        "name": "core_echo_write",
        "description": "Echo a message as a write. Fixture used only in tests.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "message": {
              "type": "string",
              "minLength": 1
            },
            "phone": {
              "type": "string"
            },
            "dryRun": {
              "type": "boolean",
              "default": true,
              "description": "Defaults to true: validate and audit only. Pass false to actually run the write."
            },
            "idempotencyKey": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "description": "Required when dryRun is false. Same key + same input replays the stored result."
            }
          },
          "required": [
            "message"
          ],
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": false,
          "destructiveHint": true,
          "openWorldHint": false
        }
      },
      {
        "name": "qvo_get_tenant",
        "description": "Get the bound tenant's name, timezone and enabled tools.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "tenantId": {
              "type": "string",
              "minLength": 1
            }
          },
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": true,
          "destructiveHint": false,
          "openWorldHint": false
        }
      },
      {
        "name": "qvo_list_actions",
        "description": "List the QVO actions this key can call over MCP, with kind and required scope.",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": true,
          "destructiveHint": false,
          "openWorldHint": false
        }
      },
      {
        "name": "qvo_list_templates",
        "description": "List use-case templates (barbershop, nail salon, …). Returns [] until templates ship.",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": true,
          "destructiveHint": false,
          "openWorldHint": false
        }
      },
      {
        "name": "test_notes_list",
        "description": "List notes for the bound tenant. Fixture used only in tests.",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": true,
          "destructiveHint": false,
          "openWorldHint": false
        }
      }
    ]
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

### 2. tools/call qvo_get_tenant

```text
→ {
  "method": "tools/call",
  "params": {
    "name": "qvo_get_tenant",
    "arguments": {}
  },
  "jsonrpc": "2.0",
  "id": 2
}
← {
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\n  \"ok\": true,\n  \"data\": {\n    \"name\": \"Marco’s Barbershop\",\n    \"timezone\": \"America/Chicago\",\n    \"enabledTools\": [\n      \"scheduling\",\n      \"sms\",\n      \"tickets\"\n    ]\n  }\n}"
      }
    ],
    "isError": false
  },
  "jsonrpc": "2.0",
  "id": 2
}
```

### 3. tools/call qvo_get_tenant for another tenant (refused)

```text
→ {
  "method": "tools/call",
  "params": {
    "name": "qvo_get_tenant",
    "arguments": {
      "tenantId": "tenant-b"
    }
  },
  "jsonrpc": "2.0",
  "id": 3
}
← {
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\n  \"ok\": false,\n  \"error\": {\n    \"code\": \"FORBIDDEN\",\n    \"message\": \"This key is bound to a different tenant\",\n    \"callerSafeMessage\": \"I don't have permission to do that.\",\n    \"retryable\": false,\n    \"field\": \"tenantId\"\n  }\n}"
      }
    ],
    "isError": true
  },
  "jsonrpc": "2.0",
  "id": 3
}
```

### 4. tools/call core_echo_write without dryRun (dry run by default)

```text
→ {
  "method": "tools/call",
  "params": {
    "name": "core_echo_write",
    "arguments": {
      "message": "hello"
    }
  },
  "jsonrpc": "2.0",
  "id": 4
}
← {
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\n  \"ok\": true,\n  \"data\": {\n    \"dryRun\": true,\n    \"action\": \"core.echo.write\",\n    \"kind\": \"write\",\n    \"input\": {\n      \"message\": \"hello\"\n    }\n  },\n  \"readback\": \"Dry run: core.echo.write was validated and not executed. Pass dryRun: false and an idempotencyKey to run it.\"\n}"
      }
    ],
    "isError": false
  },
  "jsonrpc": "2.0",
  "id": 4
}
```

### Audit rows written (PR-01 `action_audit_log` store)

```json
[
  {
    "tenantId": "tenant-a",
    "action": "qvo.get_tenant",
    "actor": {
      "type": "mcp",
      "id": "env:admin-a"
    },
    "resultCode": "ok"
  },
  {
    "tenantId": "tenant-a",
    "action": "qvo.get_tenant",
    "actor": {
      "type": "mcp",
      "id": "env:admin-a"
    },
    "resultCode": "FORBIDDEN"
  },
  {
    "tenantId": "tenant-a",
    "action": "core.echo.write",
    "actor": {
      "type": "mcp",
      "id": "env:admin-a"
    },
    "resultCode": "dry_run"
  }
]
```
