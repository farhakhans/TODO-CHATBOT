import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput } from "@/components/ChatInput";
import { TodoPanel } from "@/components/TodoPanel";
import { Bot, LogOut, PanelRightOpen, PanelRightClose, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

type Msg = { role: "user" | "assistant"; content: string };

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/todo-chat`;

export default function Chat() {
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showTodos, setShowTodos] = useState(true);
  const [todoRefresh, setTodoRefresh] = useState(0);
  const [conversationId] = useState(() => crypto.randomUUID());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Notification beep + voice readout
  const playNotification = useCallback((text?: string) => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 660;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch {}

    // Voice readout using browser Speech Synthesis
    if (text && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.1;
        utterance.pitch = 1;
        utterance.volume = 0.8;
        // Pick a Hindi voice if available, else default
        const voices = window.speechSynthesis.getVoices();
        const hindiVoice = voices.find(v => v.lang.startsWith("hi"));
        if (hindiVoice) utterance.voice = hindiVoice;
        window.speechSynthesis.speak(utterance);
      } catch {}
    }
  }, []);

  // Load conversation history
  useEffect(() => {
    if (!user) return;
    supabase
      .from("chat_messages")
      .select("role, content")
      .eq("user_id", user.id)
      .eq("conversation_id", conversationId)
      .order("created_at")
      .then(({ data }) => {
        if (data && data.length > 0) {
          setMessages(data as Msg[]);
        }
      });
  }, [user, conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async (input: string) => {
    if (!user) return;
    const userMsg: Msg = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    await supabase.from("chat_messages").insert({
      user_id: user.id,
      conversation_id: conversationId,
      role: "user",
      content: input,
    });

    let assistantSoFar = "";
    const upsertAssistant = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) =>
            i === prev.length - 1 ? { ...m, content: assistantSoFar } : m
          );
        }
        return [...prev, { role: "assistant", content: assistantSoFar }];
      });
    };

    try {
      const resp = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          messages: [...messages, userMsg],
          userId: user.id,
          conversationId,
        }),
      });

      if (resp.status === 429) {
        toast({ variant: "destructive", title: "Rate limited", description: "Please try again in a moment." });
        setIsLoading(false);
        return;
      }
      if (resp.status === 402) {
        toast({ variant: "destructive", title: "Usage limit", description: "AI credits exhausted. Please add more." });
        setIsLoading(false);
        return;
      }
      if (!resp.ok || !resp.body) throw new Error("Failed to start stream");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) upsertAssistant(content);

            const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
            if (toolCalls) setTodoRefresh((prev) => prev + 1);
          } catch {
            textBuffer = line + "\n" + textBuffer;
            break;
          }
        }
      }

      if (textBuffer.trim()) {
        for (let raw of textBuffer.split("\n")) {
          if (!raw) continue;
          if (raw.endsWith("\r")) raw = raw.slice(0, -1);
          if (raw.startsWith(":") || raw.trim() === "") continue;
          if (!raw.startsWith("data: ")) continue;
          const jsonStr = raw.slice(6).trim();
          if (jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) upsertAssistant(content);
          } catch {}
        }
      }

      if (assistantSoFar) {
        playNotification(assistantSoFar);
        await supabase.from("chat_messages").insert({
          user_id: user.id,
          conversation_id: conversationId,
          role: "assistant",
          content: assistantSoFar,
        });
        setTodoRefresh((prev) => prev + 1);
      }
    } catch (e: any) {
      console.error(e);
      toast({ variant: "destructive", title: "Error", description: e.message || "Something went wrong" });
    } finally {
      setIsLoading(false);
    }
  }, [user, messages, conversationId, toast]);

  const todoPanelContent = user ? (
    <TodoPanel userId={user.id} refreshKey={todoRefresh} />
  ) : null;

  return (
    <div className="flex h-screen bg-background">
      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <h1 className="text-sm font-bold font-mono text-foreground">todo.ai</h1>
          </div>
          <div className="flex items-center gap-1">
            {/* Mobile: drawer trigger */}
            {isMobile && user && (
              <Drawer>
                <DrawerTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ListTodo className="w-4 h-4" />
                  </Button>
                </DrawerTrigger>
                <DrawerContent className="max-h-[80vh]">
                  <DrawerHeader>
                    <DrawerTitle className="sr-only">Tasks</DrawerTitle>
                  </DrawerHeader>
                  <div className="h-[60vh]">
                    {todoPanelContent}
                  </div>
                </DrawerContent>
              </Drawer>
            )}
            {/* Desktop: toggle sidebar */}
            {!isMobile && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowTodos(!showTodos)}
                className="text-muted-foreground hover:text-foreground"
              >
                {showTodos ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={signOut}
              className="text-muted-foreground hover:text-foreground"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </header>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center glow-primary">
                <Bot className="w-8 h-8 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-bold font-mono text-foreground">Hey there!</h2>
                <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                  I'm your AI task manager. Try saying things like:
                </p>
                <div className="mt-3 space-y-1.5">
                  {[
                    "Add a task to buy groceries",
                    "Add a task due tomorrow to call the dentist",
                    "Show me my pending tasks",
                    "Mark the first task as done",
                  ].map((hint) => (
                    <p
                      key={hint}
                      className="text-xs font-mono text-muted-foreground bg-secondary/50 px-3 py-1.5 rounded-lg"
                    >
                      "{hint}"
                    </p>
                  ))}
                </div>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <ChatMessage
              key={i}
              role={msg.role}
              content={msg.content}
              isStreaming={isLoading && i === messages.length - 1 && msg.role === "assistant"}
            />
          ))}
        </div>

        {/* Input */}
        <div className="p-4 border-t border-border">
          <ChatInput onSend={send} disabled={isLoading} />
        </div>
      </div>

      {/* Desktop todo panel */}
      {!isMobile && showTodos && user && (
        <div className="w-80 border-l border-border bg-card hidden md:flex flex-col">
          {todoPanelContent}
        </div>
      )}
    </div>
  );
}
