import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import fetch from 'node-fetch';

// Create an output channel for debugging
const outputChannel = vscode.window.createOutputChannel('AI Chat Extension');

// Define TreeItem for the explorer view
class TreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState
	) {
		super(label, collapsibleState);
	}
}

// Simple Tree Data Provider for the explorer view
class SimpleTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | null | void> = new vscode.EventEmitter<TreeItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

	getTreeItem(element: TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeItem): Thenable<TreeItem[]> {
		if (element) {
			return Promise.resolve([]);
		} else {
			// Root elements (welcome message)
			const welcomeItem = new TreeItem(
				'Enter your Bugs and Queries here to get AI suggestions',
				vscode.TreeItemCollapsibleState.None
			);
			
			return Promise.resolve([welcomeItem]);
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	console.log('AI Chat extension is now active');
	outputChannel.appendLine('AI Chat extension is now active');
	
	// Register the AI Chat webview provider
	const provider = new AiChatViewProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(AiChatViewProvider.viewType, provider)
	);
	
	// Register command to analyze current file
	const analyzeFileCommand = vscode.commands.registerCommand('Ai-Chat.analyzeCurrentFile', () => {
		if (vscode.window.activeTextEditor) {
			const document = vscode.window.activeTextEditor.document;
			const code = document.getText();
			const fileName = path.basename(document.fileName);
			
				// Send the code to the chat view
			provider.sendCodeToView(code, fileName);
			
			// Focus the AI Chat view
			vscode.commands.executeCommand('ai-chat-view.focus');
		} else {
			vscode.window.showInformationMessage('No active file to analyze');
		}
	});
	
	// Register command to browse and select files for analysis
	const browseFileCommand = vscode.commands.registerCommand('Ai-Chat.browseFile', async () => {
		// Show file open dialog
		const fileUris = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			openLabel: 'Select File to Analyze'
		});
		
		if (fileUris && fileUris.length > 0) {
			const fileUri = fileUris[0];
			try {
				// Read file content
				const fileContent = await fs.promises.readFile(fileUri.fsPath, 'utf8');
				const fileName = path.basename(fileUri.fsPath);
				
				// Send the code to the chat view
				provider.sendCodeToView(fileContent, fileName);
				
				// Focus the AI Chat view
				vscode.commands.executeCommand('workbench.view.extension.ai-chat-sidebar');
				vscode.commands.executeCommand('ai-chat-view.focus');
			} catch (error) {
				vscode.window.showErrorMessage(`Error reading file: ${error}`);
			}
		}
	});

	// New command to pick files from VS Code workspace
	const pickWorkspaceFileCommand = vscode.commands.registerCommand('Ai-Chat.pickWorkspaceFile', async () => {
		// Get all files in workspace
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			vscode.window.showInformationMessage('No workspace open. Please open a folder first.');
			return;
		}

		// Get all files in workspace using file system
		const allFiles: vscode.Uri[] = [];
		
		for (const folder of workspaceFolders) {
			try {
				// Find files in this workspace folder
				const files = await vscode.workspace.findFiles(
					'**/*', // Include all files
					'**/node_modules/**', // Exclude node_modules
					1000 // Limit to 1000 files for performance
				);
				allFiles.push(...files);
			} catch (error) {
				console.error(`Error finding files in ${folder.name}:`, error);
			}
		}

		if (allFiles.length === 0) {
			vscode.window.showInformationMessage('No files found in workspace.');
			return;
		}

		// Create QuickPick items from files
		const quickPickItems = allFiles.map(file => ({
			label: path.basename(file.fsPath),
			description: vscode.workspace.asRelativePath(file.fsPath),
			uri: file
		}));

		// Show QuickPick
		const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
			placeHolder: 'Select a file to attach'
		});

		if (!selectedItem) {
			return; // User cancelled
		}

		try {
			// Read file content
			const fileContent = await fs.promises.readFile(selectedItem.uri.fsPath, 'utf8');
			const fileName = path.basename(selectedItem.uri.fsPath);
			
			// Send the code to the chat view or attach it
			provider.addAttachment(fileContent, fileName, selectedItem.uri.fsPath);
			
			// Focus the AI Chat view
			vscode.commands.executeCommand('ai-chat-view.focus');
			
			vscode.window.showInformationMessage(`Attached ${fileName} to chat`);
		} catch (error) {
			vscode.window.showErrorMessage(`Error reading file: ${error}`);
		}
	});
	
	// Register command to attach selected file to chat
	const attachFileCommand = vscode.commands.registerCommand('Ai-Chat.attachFileToChat', async (resource) => {
		let fileUri;
		
		// Check if command was triggered from explorer context menu (with resource)
		if (resource && resource.fsPath) {
			fileUri = resource;
		} 
		// Or from editor context menu (use active editor)
		else if (vscode.window.activeTextEditor) {
			fileUri = vscode.window.activeTextEditor.document.uri;
		}
		// If no file is selected, show an error
		else {
			vscode.window.showErrorMessage('No file selected to attach');
			return;
		}
		
		try {
			// Read file content
			const fileContent = await fs.promises.readFile(fileUri.fsPath, 'utf8');
			const fileName = path.basename(fileUri.fsPath);
			
				// Add the file to the chat
			provider.addAttachment(fileContent, fileName, fileUri.fsPath);
			
			// Focus the AI Chat view
			vscode.commands.executeCommand('ai-chat-view.focus');
			
			vscode.window.showInformationMessage(`Attached ${fileName} to AI Chat`);
		} catch (error) {
			vscode.window.showErrorMessage(`Error attaching file: ${error}`);
		}
	});
	
	// Register command to clear chat history
	const clearChatCommand = vscode.commands.registerCommand('Ai-Chat.clearChat', () => {
		outputChannel.appendLine('Clear chat command triggered');
		vscode.window.showInformationMessage('Clearing chat history...');
		provider.clearChat();
	});
	
	// Register tree view provider for navigation sidebar
	const treeDataProvider = new SimpleTreeDataProvider();
	const treeView = vscode.window.createTreeView('ai-chat-explorer', {
		treeDataProvider: treeDataProvider
	});
	
	context.subscriptions.push(analyzeFileCommand);
	context.subscriptions.push(browseFileCommand);
	context.subscriptions.push(attachFileCommand);
	context.subscriptions.push(clearChatCommand);
	context.subscriptions.push(pickWorkspaceFileCommand); // Add the new command
	context.subscriptions.push(treeView);
}

// The WebView Provider for AI Chat (sidebar implementation)
class AiChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ai-chat-view';
	
	private _view?: vscode.WebviewView;
	
	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }
	
	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;
		
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri
			]
		};
		
		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
		
		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(async (data) => {
			switch (data.command) {
				case 'analyze':
					try {
						const response = await this._analyzeCode(data.code, data.purpose, data.attachments);
						webviewView.webview.postMessage({ 
							command: 'analysisResult', 
							result: response 
						});
					} catch (error) {
						webviewView.webview.postMessage({ 
							command: 'error', 
							message: 'Error analyzing code: ' + (error instanceof Error ? error.message : String(error))
						});
					}
					break;
					
				case 'analyzeCurrentFile':
					// Execute the command registered with VS Code
					vscode.commands.executeCommand('Ai-Chat.analyzeCurrentFile');
					break;
					
				case 'browseFile':
					// Execute the command registered with VS Code
					vscode.commands.executeCommand('Ai-Chat.browseFile');
					break;
					
				case 'pickWorkspaceFile':
					// Execute the new command to pick files from workspace
					vscode.commands.executeCommand('Ai-Chat.pickWorkspaceFile');
					break;
			}
		});
	}
	
	public sendCodeToView(code: string, fileName: string) {
		if (this._view) {
			this._view.webview.postMessage({ 
				command: 'setCode', 
				code, 
				fileName 
			});
		}
	}
	
	public addAttachment(content: string, fileName: string, filePath: string) {
		if (this._view) {
			this._view.webview.postMessage({ 
				command: 'addAttachment', 
				content, 
				fileName,
				filePath
			});
		}
	}
	
	// Add method to clear chat with improved error handling
	public clearChat() {
		if (this._view) {
			try {
				this._view.webview.postMessage({ 
					command: 'clearChat',
					timestamp: new Date().getTime() // Add timestamp to ensure message uniqueness
				});
				console.log('Sent clearChat message to webview');
			} catch (error) {
				console.error('Error sending clearChat message:', error);
			}
		} else {
			console.error('Cannot clear chat: Webview not available');
		}
	}
	
	private async _analyzeCode(code: string, purpose: string, attachments: any[] = []): Promise<any> {
		try {
			// Create a request payload object for logging and sending
			const requestPayload = {
				code: code,
				purpose: purpose,
				attachments: attachments
			};
			
			// Log the full payload details to the output channel
			outputChannel.appendLine('==================================================');
			outputChannel.appendLine('REQUEST PAYLOAD DETAILS:');
			outputChannel.appendLine('==================================================');
			outputChannel.appendLine(`Time: ${new Date().toISOString()}`);
			outputChannel.appendLine(`Purpose: ${purpose}`);
			outputChannel.appendLine(`Code length: ${code.length} characters`);
			outputChannel.appendLine(`Code preview: ${code}`);
			outputChannel.appendLine(`Attachments: ${attachments.length}`);
			
			// Log each attachment
			if (attachments.length > 0) {
				outputChannel.appendLine('\nATTACHMENTS:');
				attachments.forEach((attachment, index) => {
					outputChannel.appendLine(`\n[${index + 1}] ${attachment.fileName}`);
					outputChannel.appendLine(`    Path: ${attachment.filePath}`);
					outputChannel.appendLine(`    Content length: ${attachment.content.length} characters`);
					outputChannel.appendLine(`    Content preview: ${attachment.content.substring(0, 100)}...`);
				});
			}
			
			// Log the raw JSON payload
			outputChannel.appendLine('\nRAW JSON PAYLOAD:');
			outputChannel.appendLine(JSON.stringify(requestPayload, null, 2));
			outputChannel.appendLine('==================================================');
			
				// Send the request
			const response = await fetch('http://127.0.0.1:8080/analyze', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestPayload)
			});

			if (!response.ok) {
				throw new Error('Network response was not ok: ' + response.statusText);
			}

			// Parse and log the response
			const responseData = await response.json();
			outputChannel.appendLine('\nRESPONSE FROM SERVER:');
			outputChannel.appendLine(JSON.stringify(responseData, null, 2));
			outputChannel.appendLine('==================================================');
			
			return responseData;
		} catch (error) {
			console.error('Error analyzing code:', error);
			outputChannel.appendLine(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}
	
	private _getHtmlForWebview(webview: vscode.Webview) {
		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>AI Chat</title>
			<style>
				body {
					font-family: var(--vscode-font-family);
					padding: 0;
					margin: 0;
					color: var(--vscode-foreground);
					background-color: var(--vscode-editor-background);
					display: flex;
					flex-direction: column;
					height: 100vh;
					overflow: hidden;
				}
				.chat-container {
					display: flex;
					flex-direction: column;
					height: 100vh;
					box-sizing: border-box;
					overflow: hidden;
				}
				.messages {
					flex: 1;
					overflow-y: auto;
					margin-bottom: 10px;
					padding: 8px;
				}
				.message {
					margin-bottom: 12px;
					display: flex;
				}
				.message.user {
					justify-content: flex-end;
				}
				.message.assistant {
					justify-content: flex-start;
				}
				.message-content {
					padding: 8px 10px;
					border-radius: 6px;
					max-width: 100%;
					word-break: break-word;
					box-shadow: 0 1px 3px rgba(0,0,0,0.1);
					transition: background-color 0.2s ease;
					margin: 4px 0;
					white-space: pre-wrap;
					overflow-x: auto;
					font-size: 12px;
				}
				.message.user .message-content {
					background-color: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
				}
				.message.assistant .message-content {
					background-color: var(--vscode-list-hoverBackground);
					color: var(--vscode-foreground);
					font-family: 'Consolas', monospace;
					font-size: 12px;
				}
				.message.assistant.error .message-content {
					background-color: var(--vscode-errorForeground, #ffebee);
					opacity: 0.7;
				}
				.input-container {
					display: flex;
					flex-direction: column;
					gap: 5px;
					padding: 8px;
					border-top: 1px solid var(--vscode-panel-border);
					background-color: var(--vscode-sideBar-background);
				}
				.input-wrapper {
					display: flex;
					flex-direction: column;
					gap: 5px;
					width: 100%;
				}
				.top-input-container {
					display: flex;
					gap: 5px;
					width: 100%;
				}
				.purpose-input {
					flex: 1;
					padding: 4px 8px;
					border: 1px solid var(--vscode-input-border);
					border-radius: 2px;
					background-color: var(--vscode-input-background);
					color: var(--vscode-input-foreground);
					height: 24px;
					outline: none;
					font-size: 12px;
				}
				.error-message {
					color: var(--vscode-errorForeground);
					font-size: 12px;
					margin-top: 4px;
					text-align: left;
				}
				.input {
					width: 100%;
					padding: 4px 8px;
					border: 1px solid var(--vscode-input-border);
					border-radius: 2px;
					background-color: var(--vscode-input-background);
					color: var(--vscode-input-foreground);
					outline: none;
					min-height: 60px;
					resize: vertical;
					box-sizing: border-box;
					font-family: 'Consolas', monospace;
					font-size: 12px;
				}
				.send-button {
					height: 35px;
					padding: 4px 8px;
					background-color: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					border: none;
					border-radius: 2px;
					font-size: 12px;
					transition: all 0.2s ease;
					cursor: pointer;
				}
				.send-button:disabled {
					opacity: 0.5;
					cursor: not-allowed;
				}
				.file-actions {
					display: flex;
					justify-content: space-between;
					margin-top: 5px;
				}
				.file-button {
					background-color: var(--vscode-button-secondaryBackground);
					color: var(--vscode-button-secondaryForeground);
					border: none;
					border-radius: 2px;
					padding: 4px 6px;
					font-size: 11px;
					cursor: pointer;
					flex: 1;
					margin: 0 2px;
					white-space: nowrap;
					text-overflow: ellipsis;
					overflow: hidden;
				}
				.attachments-container {
					margin-top: 5px;
					border: 1px solid var(--vscode-input-border);
					border-radius: 2px;
					padding: 4px;
					background-color: var(--vscode-input-background);
					max-height: 100px;
					overflow-y: auto;
					font-size: 11px;
				}
				.attachment {
					display: flex;
					justify-content: space-between;
					align-items: center;
					padding: 2px 4px;
					margin-bottom: 2px;
					background-color: var(--vscode-list-hoverBackground);
					border-radius: 2px;
				}
				.attachment-name {
					font-size: 11px;
					margin-right: 5px;
					white-space: nowrap;
					overflow: hidden;
					text-overflow: ellipsis;
				}
				.attachment-remove {
					cursor: pointer;
					color: var(--vscode-errorForeground);
					font-size: 11px;
					user-select: none;
				}
				.attachment-badge {
					display: inline-flex;
					align-items: center;
					padding: 1px 4px;
					margin-right: 3px;
					background-color: var(--vscode-badge-background);
					color: var(--vscode-badge-foreground);
					border-radius: 8px;
					font-size: 9px;
				}
				.attachments-header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 4px;
				}
				.attachments-title {
					font-size: 11px;
					font-weight: bold;
					color: var(--vscode-descriptionForeground);
				}
				.header-container {
					display: flex;
					justify-content: flex-end;
					padding: 4px 8px;
					border-bottom: 1px solid var(--vscode-panel-border);
				}
				
				.clear-chat-button {
					background-color: transparent;
					color: var(--vscode-descriptionForeground);
					border: none;
					font-size: 11px;
					padding: 2px 6px;
					cursor: pointer;
					display: flex;
					align-items: center;
					gap: 4px;
				}
				
				.clear-chat-button:hover {
					color: var(--vscode-errorForeground);
				}
				
				.clear-icon {
					font-size: 10px;
				}
			</style>
		</head>
		<body>
			<div class="chat-container">
				<div class="messages" id="messages"></div>
				<div class="input-container">
					<div class="input-wrapper">
						<div id="attachments-container" class="attachments-container" style="display: none;">
							<div class="attachments-header">
								<div class="attachments-title">Attached Files</div>
								<div class="attachment-remove" id="clear-attachments">Clear All</div>
							</div>
							<div id="attachments-list"></div>
						</div>
						
						<textarea
							id="code-input"
							class="input"
							placeholder="Type your code here... (Ctrl + Enter to send)"
						></textarea>
						
						<div class="top-input-container">
							<input
								id="purpose-input"
								class="purpose-input"
								placeholder="Enter purpose..."
							/>
							<button 
								id="send-button" 
								class="send-button" 
								disabled
							>
								Send
							</button>
						</div>
						
						<div class="file-actions">
							<button id="pick-workspace-file-button" class="file-button">Browse Workspace</button>
						</div>
						
						<div id="error-message" class="error-message"></div>
					</div>
				</div>
			</div>

			<script>
				(function() {
					const vscode = acquireVsCodeApi();
					const messagesContainer = document.getElementById('messages');
					const purposeInput = document.getElementById('purpose-input');
					const codeInput = document.getElementById('code-input');
					const sendButton = document.getElementById('send-button');
					const errorMessage = document.getElementById('error-message');
					const pickWorkspaceFileButton = document.getElementById('pick-workspace-file-button');
					const attachmentsContainer = document.getElementById('attachments-container');
					const attachmentsList = document.getElementById('attachments-list');
					const clearAttachments = document.getElementById('clear-attachments');

					// Keep track of messages and restore any saved ones
					let messages = [];
					let attachments = [];
					
					const state = vscode.getState();
					if (state) {
						if (state.messages) {
							messages = state.messages;
							renderMessages();
						}
						if (state.attachments) {
							attachments = state.attachments;
							renderAttachments();
						}
					}

					// Update button state
					function updateButtonState() {
						sendButton.disabled = !codeInput.value.trim() || !purposeInput.value.trim();
					}

					// Event listeners
					purposeInput.addEventListener('input', updateButtonState);
					codeInput.addEventListener('input', updateButtonState);

					// Clear all attachments
					clearAttachments.addEventListener('click', () => {
						attachments = [];
						renderAttachments();
						saveState();
					});

					// Pick workspace file button handler
					pickWorkspaceFileButton.addEventListener('click', () => {
						vscode.postMessage({ command: 'pickWorkspaceFile' });
					});

					// Add attachment to the list
					function addAttachment(content, fileName, filePath) {
						// Check if file is already attached
						const exists = attachments.find(a => a.filePath === filePath);
						if (exists) {
							// Update content if file already exists
							exists.content = content;
						} else {
							// Add new attachment
							attachments.push({
								fileName,
								content,
								filePath
							});
						}
						
						renderAttachments();
						saveState();
					}
					
					// Render attachments
					function renderAttachments() {
						if (attachments.length === 0) {
							attachmentsContainer.style.display = 'none';
							return;
						}
						
						attachmentsContainer.style.display = 'block';
						attachmentsList.innerHTML = '';
						
						attachments.forEach((attachment, index) => {
							const attachmentEl = document.createElement('div');
							attachmentEl.className = 'attachment';
							
							const nameEl = document.createElement('div');
							nameEl.className = 'attachment-name';
							nameEl.textContent = attachment.fileName;
							
							const actionsEl = document.createElement('div');
							actionsEl.className = 'attachment-actions';
							
							const removeEl = document.createElement('div');
							removeEl.className = 'attachment-remove';
							removeEl.textContent = '✕';
							removeEl.addEventListener('click', () => {
								attachments.splice(index, 1);
								renderAttachments();
								saveState();
							});
							
							actionsEl.appendChild(removeEl);
							attachmentEl.appendChild(nameEl);
							attachmentEl.appendChild(actionsEl);
							attachmentsList.appendChild(attachmentEl);
						});
					}

					// Send message function
					function sendMessage() {
						const code = codeInput.value.trim();
						const purpose = purposeInput.value.trim();

						if (!code || !purpose) {
							return;
						}
						
						// Log details about what's being sent
						console.log('====== SENDING MESSAGE ======');
						console.log('Purpose:', purpose);
						console.log('Code length:', code.length);
						console.log('Code preview:', code.substring(0, 100) + '...');
						console.log('Attachments count:', attachments.length);
						
						// Log details of each attachment
						if (attachments.length > 0) {
							console.log('ATTACHMENTS:');
							attachments.forEach((a, i) => {
								console.log(\`[\${i+1}] \${a.fileName} (\${a.filePath})\`);
								console.log(\`    Content length: \${a.content.length}\`);
								console.log(\`    Content preview: \${a.content.substring(0, 100)}...\`);
							});
						}

						// Format message content to include attachments if present
						let content = \`Purpose: \${purpose}\n\n\${code}\`;
						
						if (attachments.length > 0) {
							content += \`\n\nAttached Files:\n\`;
							attachments.forEach(a => {
								content += \`- \${a.fileName}\n\`;
							});
						}

						// Add user message to UI
						const userMessage = {
							role: 'user',
							content: content,
							purpose: purpose,
							attachments: [...attachments] // Make a copy to preserve state
						};
						messages.push(userMessage);
						renderMessages();
						saveState();

						// Clear inputs
						codeInput.value = '';
						purposeInput.value = '';
						// Keep attachments unless user clears them
						updateButtonState();

						// Send to extension
						vscode.postMessage({
							command: 'analyze',
							code: code,
							purpose: purpose,
							attachments: attachments
						});
					}

					// Handle Ctrl+Enter
					codeInput.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' && e.ctrlKey) {
							e.preventDefault();
							sendMessage();
						}
					});

					sendButton.addEventListener('click', sendMessage);

					// Save state to VS Code storage
					function saveState() {
						vscode.setState({ 
							messages,
							attachments
						});
					}

					// Render messages
					function renderMessages() {
						messagesContainer.innerHTML = '';
						messages.forEach(msg => {
							const messageDiv = document.createElement('div');
							messageDiv.className = \`message \${msg.role}\${msg.status === 'error' ? ' error' : ''}\`;

							const contentPre = document.createElement('pre');
							contentPre.className = 'message-content';
							contentPre.textContent = msg.content;

							// If message has attachments, add badge
							if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
								const badge = document.createElement('span');
								badge.className = 'attachment-badge';
								badge.textContent = \`\${msg.attachments.length} file\${msg.attachments.length > 1 ? 's' : ''}\`;
								contentPre.prepend(badge);
							}

							messageDiv.appendChild(contentPre);
							messagesContainer.appendChild(messageDiv);
						});
						// Scroll to bottom
						messagesContainer.scrollTop = messagesContainer.scrollHeight;
					}

					// Handle messages from extension with improved logging
					window.addEventListener('message', event => {
						const message = event.data;
						console.log('Received message:', message.command);
						
						switch (message.command) {
							case 'analysisResult':
								let aiResponse = "";
								const data = message.result;
								
								if (data.status === 'error') {
									// Format the response with better spacing and structure
									const fixSuggestion = data.fix_suggestion || '';
									const refactoredCode = data.refactored_code || '';
									
									aiResponse = \`### Error:\\n\${data.message || 'Unknown error'}\\n\\n\`;
									
									if (fixSuggestion) {
										aiResponse += \`### Suggested Fix:\\n\\\`\\\`\\\`\\n\${
											typeof fixSuggestion === 'object' && fixSuggestion.text
												? fixSuggestion.text
													.replace('Analyze the following Python code and suggest fixes:', '')
													.replace(/\`\`\`\\n/, '')
													.replace(/\`\`\`$/, '')
													.trim()
												: fixSuggestion
										}\\n\\\`\\\`\\\`\\n\\n\`;
									}

									if (refactoredCode) {
										aiResponse += \`### Refactored Code:\\n\\\`\\\`\\\`\\n\${
											refactoredCode
												.split('\\n')
												.map(line => line.trim())
												.join('\\n')
										}\\n\\\`\\\`\\\`\`;
									}
									
									// Add file analysis results if present
									if (data.file_analysis && data.file_analysis.length > 0) {
										aiResponse += '\\n\\n### Attached Files Analysis:';
										data.file_analysis.forEach(file => {
											aiResponse += \`\\n\\n#### \${file.fileName}:\\n\`;
											aiResponse += \`**Status**: \${file.status === 'error' ? '❌ Error' : '✅ Success'}\\n\`;
											aiResponse += \`**Message**: \${file.message}\\n\`;
											
											if (file.status === 'error' && file.fix_suggestion) {
												aiResponse += \`\\n**Suggested Fix**:\\n\\\`\\\`\\\`\\n\${
													typeof file.fix_suggestion === 'object' && file.fix_suggestion.text
														? file.fix_suggestion.text
															.replace('Analyze the following Python code and suggest fixes:', '')
															.replace(/\`\`\`\\n/, '')
															.replace(/\`\`\`$/, '')
															.trim()
														: file.fix_suggestion
												}\\n\\\`\\\`\\\`\`;
											}
										});
									}
								} else {
									aiResponse = \`### Success:\\n\${data.message || ''}\\n\\n### Code:\\n\\\`\\\`\\\`\\n\${data.code || ''}\\n\\\`\\\`\\\`\`;
									
									// Add file analysis results if there are any - especially if there are errors in attachments
									if (data.file_analysis && data.file_analysis.length > 0) {
										const errorsInAttachments = data.file_analysis.some(file => file.status === 'error');
										
										aiResponse += '\\n\\n### Attached Files Analysis:';
										
										if (errorsInAttachments) {
											aiResponse += '\\n⚠️ **Some attached files have errors:**';
										}
										
										data.file_analysis.forEach(file => {
											aiResponse += \`\\n\\n#### \${file.fileName}:\\n\`;
											aiResponse += \`**Status**: \${file.status === 'error' ? '❌ Error' : '✅ Success'}\\n\`;
											aiResponse += \`**Message**: \${file.message}\\n\`;
											
											if (file.status === 'error' && file.fix_suggestion) {
												aiResponse += \`\\n**Suggested Fix**:\\n\\\`\\\`\\\`\\n\${
													typeof file.fix_suggestion === 'object' && file.fix_suggestion.text
														? file.fix_suggestion.text
															.replace('Analyze the following Python code and suggest fixes:', '')
															.replace(/\`\`\`\\n/, '')
															.replace(/\`\`\`$/, '')
															.trim()
														: file.fix_suggestion
												}\\n\\\`\\\`\\\`\`;
											}
										});
									}
								}

								const aiMessage = { 
									role: "assistant", 
									content: aiResponse,
									status: data.status 
								};
								
								messages.push(aiMessage);
								renderMessages();
								saveState();
								break;
							
							case 'error':
								const errorMessage = { 
									role: "assistant", 
									content: message.message,
									status: "error"
								};
								messages.push(errorMessage);
								renderMessages();
								saveState();
								break;
							
							case 'setCode':
								codeInput.value = message.code;
								purposeInput.value = "Analyze " + message.fileName;
								updateButtonState();
								break;
								
							case 'addAttachment':
								addAttachment(message.content, message.fileName, message.filePath);
								break;
								
							case 'clearChat':
								console.log('Processing clearChat command');
								// Skip confirmation for now to ensure functionality
								messages = [];
								console.log('Messages array cleared, length:', messages.length);
								renderMessages();
								saveState();
								console.log('Chat cleared successfully');
								break;
						}
					});

					// Initial state
					updateButtonState();
				})();
			</script>
		</body>
		</html>`;
	}
}

export function deactivate() {}