import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const tools = [
  {
    type: "function" as const,
    function: {
      name: "add_todo",
      description: "Add a new task/todo for the user. Can optionally set a due date.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The title of the task" },
          due_at: { type: "string", description: "Optional ISO 8601 due date/time. e.g. '2026-02-15T09:00:00Z'. Parse natural language dates relative to today." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_todos",
      description: "List all tasks/todos for the user. Can filter by completion status.",
      parameters: {
        type: "object",
        properties: {
          completed: { type: "boolean", description: "Filter by completed status. Omit to list all." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "toggle_todo",
      description: "Toggle the completion status of a task by its title (partial match)",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title or partial title of the task to toggle" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_todo",
      description: "Delete a task by its title (partial match). Can also delete all completed tasks.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title or partial title. Use '__completed__' to delete all completed tasks." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_todo",
      description: "Update the title of an existing task",
      parameters: {
        type: "object",
        properties: {
          old_title: { type: "string", description: "Current title or partial match" },
          new_title: { type: "string", description: "New title for the task" },
        },
        required: ["old_title", "new_title"],
      },
    },
  },
];

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  userId: string
): Promise<string> {
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  switch (name) {
    case "add_todo": {
      const insertData: Record<string, unknown> = { user_id: userId, title: args.title as string };
      if (args.due_at) insertData.due_at = args.due_at;
      const { error } = await db.from("todos").insert(insertData);
      if (error) return `Error: ${error.message}`;
      const dueStr = args.due_at ? ` (due: ${args.due_at})` : "";
      return `Added task: "${args.title}"${dueStr}`;
    }

    case "list_todos": {
      let query = db.from("todos").select("*").eq("user_id", userId).order("created_at", { ascending: false });
      if (args.completed !== undefined) {
        query = query.eq("completed", args.completed as boolean);
      }
      const { data, error } = await query;
      if (error) return `Error: ${error.message}`;
      if (!data || data.length === 0) return "No tasks found.";
      return data
        .map(
          (t: { title: string; completed: boolean; due_at: string | null }, i: number) => {
            const due = t.due_at ? ` [due: ${new Date(t.due_at).toLocaleDateString()}]` : "";
            return `${i + 1}. [${t.completed ? "✓" : " "}] ${t.title}${due}`;
          }
        )
        .join("\n");
    }

    case "toggle_todo": {
      const { data: matches } = await db
        .from("todos")
        .select("*")
        .eq("user_id", userId)
        .ilike("title", `%${args.title}%`)
        .limit(1);
      if (!matches || matches.length === 0) return `No task found matching "${args.title}"`;
      const todo = matches[0];
      const { error } = await db
        .from("todos")
        .update({ completed: !todo.completed })
        .eq("id", todo.id);
      if (error) return `Error: ${error.message}`;
      return `${todo.completed ? "Uncompleted" : "Completed"}: "${todo.title}"`;
    }

    case "delete_todo": {
      if (args.title === "__completed__") {
        const { error } = await db
          .from("todos")
          .delete()
          .eq("user_id", userId)
          .eq("completed", true);
        if (error) return `Error: ${error.message}`;
        return "Deleted all completed tasks.";
      }
      const { data: matches } = await db
        .from("todos")
        .select("*")
        .eq("user_id", userId)
        .ilike("title", `%${args.title}%`)
        .limit(1);
      if (!matches || matches.length === 0) return `No task found matching "${args.title}"`;
      const { error } = await db.from("todos").delete().eq("id", matches[0].id);
      if (error) return `Error: ${error.message}`;
      return `Deleted: "${matches[0].title}"`;
    }

    case "update_todo": {
      const { data: matches } = await db
        .from("todos")
        .select("*")
        .eq("user_id", userId)
        .ilike("title", `%${args.old_title}%`)
        .limit(1);
      if (!matches || matches.length === 0) return `No task found matching "${args.old_title}"`;
      const { error } = await db
        .from("todos")
        .update({ title: args.new_title as string })
        .eq("id", matches[0].id);
      if (error) return `Error: ${error.message}`;
      return `Updated "${matches[0].title}" → "${args.new_title}"`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, userId } = await req.json();

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const systemPrompt = `You are a friendly and concise AI task manager called todo.ai. You help users manage their tasks through conversation.
Current date/time: ${new Date().toISOString()}.

When users ask to add, list, complete, delete, or update tasks, use the available tools.
When a user mentions a deadline or due date, parse it into ISO 8601 and pass it as due_at.
When listing tasks, format them nicely and mention due dates. Be brief and helpful.
If a user's request is ambiguous, ask for clarification.
Always confirm actions you've taken.`;

    const allMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m: { role: string; content: string }) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    // First call - may return tool calls
    let response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: allMessages,
        tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let result = await response.json();
    let assistantMessage = result.choices[0].message;

    // Handle tool calls in a loop
    const conversationMessages = [...allMessages];
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (assistantMessage.tool_calls && iterations < MAX_ITERATIONS) {
      iterations++;
      conversationMessages.push(assistantMessage);

      // Execute all tool calls
      for (const toolCall of assistantMessage.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs = JSON.parse(toolCall.function.arguments);
        console.log(`Executing tool: ${fnName}`, fnArgs);

        const toolResult = await executeTool(fnName, fnArgs, userId);
        conversationMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      // Call AI again with tool results
      response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: conversationMessages,
          tools,
          stream: false,
        }),
      });

      if (!response.ok) {
        const t = await response.text();
        console.error("AI gateway error on tool follow-up:", response.status, t);
        break;
      }

      result = await response.json();
      assistantMessage = result.choices[0].message;
    }

    // Now stream the final response
    const finalContent = assistantMessage.content || "Done!";

    // Create a streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send the content as a single SSE chunk for simplicity
        const data = JSON.stringify({
          choices: [{ delta: { content: finalContent } }],
        });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("todo-chat error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
