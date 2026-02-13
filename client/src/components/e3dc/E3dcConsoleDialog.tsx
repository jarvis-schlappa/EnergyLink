import { useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface E3dcConsoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function E3dcConsoleDialog({ open, onOpenChange }: E3dcConsoleDialogProps) {
  const [commandInput, setCommandInput] = useState("");
  const [commandOutput, setCommandOutput] = useState("");

  const executeCommandMutation = useMutation({
    mutationFn: async (command: string) => {
      const res = await apiRequest("POST", "/api/e3dc/execute-command", { command });
      const data = await res.json();
      return data as { output: string };
    },
    onSuccess: (data: { output: string }) => {
      setCommandOutput(data.output);
    },
    onError: (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setCommandOutput(`Fehler: ${errorMessage}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" style={{ top: '2%', transform: 'translateX(-50%)' }} data-testid="dialog-e3dc-console">
        <DialogHeader>
          <DialogTitle>E3DC Console</DialogTitle>
          <DialogDescription>
            Direktes Ausführen von e3dcset Befehlen (ohne Prefix)
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="z.B.: -s discharge 1  oder  -c 3000"
              value={commandInput}
              onChange={(e) => setCommandInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  executeCommandMutation.mutate(commandInput);
                }
              }}
              disabled={executeCommandMutation.isPending}
              data-testid="input-e3dc-command"
            />
            <Button
              onClick={() => executeCommandMutation.mutate(commandInput)}
              disabled={executeCommandMutation.isPending || !commandInput.trim()}
              data-testid="button-execute-command"
            >
              <Play className="w-4 h-4 mr-2" />
              Run
            </Button>
          </div>
          
          <div className="bg-muted rounded-md p-3 font-mono text-sm min-h-[200px] max-h-[240px] overflow-y-auto border">
            <div className="text-muted-foreground whitespace-pre-wrap break-words" data-testid="text-command-output">
              {commandOutput || "Output wird hier angezeigt..."}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Der e3dcset-Prefix wird automatisch hinzugefügt. Geben Sie nur die Parameter ein.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
