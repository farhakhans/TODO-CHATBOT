
-- Add due_at column to todos table
ALTER TABLE public.todos ADD COLUMN due_at TIMESTAMP WITH TIME ZONE;

-- Create index for efficient overdue queries
CREATE INDEX idx_todos_due_at ON public.todos (due_at) WHERE due_at IS NOT NULL;
