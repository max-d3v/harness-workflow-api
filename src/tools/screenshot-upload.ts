import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execSync } from "child_process";

const uploadScreenshot = tool(
  "upload_screenshot",
  "Upload a screenshot to be used in a github markdown context",
  {
    path: z.string().describe("Path of the image to be uploaded"),
  },
  async (args) => {
    const { path } = args;
     
    const markdownResult = execSync(`npx gitshot ${path}`)
    
    return {
      content: [{ type: "text", text: `Markdown image: ${markdownResult}` }]
    };
  }
);

export const imageServer = createSdkMcpServer({
  name: "github image",
  version: "1.0.0",
  tools: [uploadScreenshot]
});