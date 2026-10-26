// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { ImageFieldReader, ImagePixels } from "../log/ImageSensor";
import type Log from "../log/Log";
import type { LogTimestamp } from "../log/LogTimestamp";
import type { SemanticType } from "../log/SemanticType";

export type LogReader = Readonly<{
  id: string;
  displayName: string;
  extensions: readonly string[];
  worker: string;
  preparation: "none" | "dslog" | "hoot" | "revlog" | "wpilogxz";
}>;

export type LogReaderRegistration = Omit<LogReader, "preparation"> & Partial<Pick<LogReader, "preparation">>;

export type SchemaDecoder = Readonly<{
  id: string;
  displayName: string;
  decode: (log: Log, key: string, timestamp: LogTimestamp, value: Uint8Array) => void;
}>;

export type ImageDecoder = Readonly<{
  id: string;
  semantic: typeof SemanticType.Image | typeof SemanticType.CompressedImage;
  decode: (read: ImageFieldReader) => ImagePixels;
}>;

export class PluginRegistry {
  private images = new Map<SemanticType, ImageDecoder>();

  registerImageDecoder(decoder: ImageDecoder): void {
    const existing = this.images.get(decoder.semantic);
    if (existing !== undefined)
      throw new Error(
        `Image semantic "${decoder.semantic}" is registered by both "${existing.id}" and "${decoder.id}".`
      );
    if ([...this.images.values()].some((entry) => entry.id === decoder.id))
      throw new Error(`Duplicate image decoder id "${decoder.id}".`);
    this.images.set(decoder.semantic, Object.freeze({ ...decoder }));
  }

  getImageDecoder(semantic: SemanticType): ImageDecoder | undefined {
    return this.images.get(semantic);
  }

  private readers = new Map<string, LogReader>();
  private extensions = new Map<string, LogReader>();
  private schemas = new Map<string, SchemaDecoder>();

  registerReader(reader: LogReaderRegistration): void {
    if (this.readers.has(reader.id)) throw new Error(`Duplicate reader id "${reader.id}".`);
    if (reader.extensions.length === 0) throw new Error(`Reader "${reader.id}" has no file extensions.`);
    const extensions = reader.extensions.map((extension) => extension.toLowerCase());
    for (const extension of extensions) {
      if (!/^[a-z0-9]+$/.test(extension)) {
        throw new Error(`Reader "${reader.id}" has invalid extension "${extension}". Use an extension without a dot.`);
      }
      const existing = this.extensions.get(extension);
      if (existing) {
        throw new Error(`Extension ".${extension}" is registered by both "${existing.id}" and "${reader.id}".`);
      }
    }
    const registered = Object.freeze({
      ...reader,
      preparation: reader.preparation ?? "none",
      extensions: Object.freeze(extensions)
    });
    this.readers.set(reader.id, registered);
    for (const extension of extensions) this.extensions.set(extension, registered);
  }

  registerSchema(schema: SchemaDecoder): void {
    if (this.schemas.has(schema.id)) throw new Error(`Duplicate schema decoder id "${schema.id}".`);
    this.schemas.set(schema.id, Object.freeze({ ...schema }));
  }

  getReader(pathOrExtension: string): LogReader | undefined {
    const filename = pathOrExtension.replaceAll("\\", "/").split("/").pop()!;
    const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    return this.extensions.get(extension);
  }

  getSchema(id: string): SchemaDecoder | undefined {
    return this.schemas.get(id);
  }

  getReaders(): readonly LogReader[] {
    return Array.from(this.readers.values());
  }

  getFileFilters(): { name: string; extensions: string[] }[] {
    const readers = this.getReaders();
    return [
      { name: "Log files", extensions: readers.flatMap((reader) => [...reader.extensions]) },
      ...readers.map((reader) => ({ name: reader.displayName, extensions: [...reader.extensions] }))
    ];
  }
}
