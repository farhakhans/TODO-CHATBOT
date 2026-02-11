import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Check, Circle, Trash2, ListTodo, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  due_at: string | null;
  created_at: string;
}

interface TodoPanelProps {
  userId: string;
  refreshKey: number;
}

function isOverdue(due_at: string | null): boolean {
  if (!due_at) return false;
  return new Date(due_at) < new Date() ;
}

function formatDue(due_at: string): string {
  const d = new Date(due_at);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays < -1) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays <= 7) return `In ${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TodoPanel({ userId, refreshKey }: TodoPanelProps) {
  const [todos, setTodos] = useState<Todo[]>([]);

  const fetchTodos = async () => {
    const { data } = await supabase
      .from("todos")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (data) setTodos(data);
  };

  useEffect(() => {
    fetchTodos();
  }, [userId, refreshKey]);

  useEffect(() => {
    const channel = supabase
      .channel("todos-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "todos", filter: `user_id=eq.${userId}` },
        () => fetchTodos()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId]);

  const toggleTodo = async (id: string, completed: boolean) => {
    await supabase.from("todos").update({ completed: !completed }).eq("id", id);
    fetchTodos();
  };

  const deleteTodo = async (id: string) => {
    await supabase.from("todos").delete().eq("id", id);
    fetchTodos();
  };

  const pending = todos.filter((t) => !t.completed);
  const completed = todos.filter((t) => t.completed);

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <ListTodo className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-medium font-mono text-foreground">Tasks</h2>
        <span className="ml-auto text-xs text-muted-foreground font-mono">
          {pending.length} pending
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {todos.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm">
            <ListTodo className="w-8 h-8 mb-2 opacity-30" />
            <p>No tasks yet</p>
            <p className="text-xs mt-1">Chat with the AI to add tasks</p>
          </div>
        )}

        {pending.map((todo) => (
          <TodoItem key={todo.id} todo={todo} onToggle={toggleTodo} onDelete={deleteTodo} />
        ))}

        {completed.length > 0 && pending.length > 0 && (
          <div className="pt-2 pb-1">
            <p className="text-xs text-muted-foreground font-mono px-1">Completed</p>
          </div>
        )}

        {completed.map((todo) => (
          <TodoItem key={todo.id} todo={todo} onToggle={toggleTodo} onDelete={deleteTodo} />
        ))}
      </div>
    </div>
  );
}

function TodoItem({
  todo,
  onToggle,
  onDelete,
}: {
  todo: Todo;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const overdue = !todo.completed && isOverdue(todo.due_at);

  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-3 py-2 rounded-lg transition-colors hover:bg-secondary/50",
        todo.completed && "opacity-50",
        overdue && "border border-destructive/30 bg-destructive/5"
      )}
    >
      <button
        onClick={() => onToggle(todo.id, todo.completed)}
        className="flex-shrink-0"
      >
        {todo.completed ? (
          <Check className="w-4 h-4 text-primary" />
        ) : (
          <Circle className="w-4 h-4 text-muted-foreground" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <span
          className={cn(
            "block text-sm truncate",
            todo.completed && "line-through text-muted-foreground"
          )}
        >
          {todo.title}
        </span>
        {todo.due_at && (
          <span className={cn(
            "flex items-center gap-1 text-[11px] mt-0.5",
            overdue ? "text-destructive" : "text-muted-foreground"
          )}>
            <Clock className="w-3 h-3" />
            {formatDue(todo.due_at)}
          </span>
        )}
      </div>
      <button
        onClick={() => onDelete(todo.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
      </button>
    </div>
  );
}
