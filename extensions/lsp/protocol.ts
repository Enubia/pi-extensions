export type JsonRpcId = number | string;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
	return "method" in m && "id" in m;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
	return "method" in m && !("id" in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
	return !("method" in m) && "id" in m;
}

export function encodeMessage(message: JsonRpcMessage): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

const HEADER_END = Buffer.from("\r\n\r\n", "ascii");

export class MessageDecoder {
	private buffer: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): JsonRpcMessage[] {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const messages: JsonRpcMessage[] = [];
		for (;;) {
			const headerEnd = this.buffer.indexOf(HEADER_END);
			if (headerEnd < 0) break;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + HEADER_END.length;
			if (this.buffer.length < bodyStart + length) break;
			const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
			this.buffer = this.buffer.subarray(bodyStart + length);
			messages.push(JSON.parse(body) as JsonRpcMessage);
		}
		return messages;
	}
}
