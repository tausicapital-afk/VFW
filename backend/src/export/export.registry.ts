import { Injectable, NotFoundException } from '@nestjs/common';
import { ExportDataset } from './export.types';

/**
 * The list of things this system can export.
 *
 * Everything downstream — the download endpoint, all three renderers, the
 * frontend's export menu — is generic over what is in here. Making a new
 * resource exportable means registering a dataset (see export.controller.ts)
 * and rendering <ExportMenu dataset="…" /> on its screen. Nothing else.
 */
@Injectable()
export class ExportRegistry {
  private readonly datasets = new Map<string, ExportDataset<never>>();

  register<T>(dataset: ExportDataset<T>): void {
    if (this.datasets.has(dataset.key)) {
      throw new Error(`Duplicate export dataset "${dataset.key}"`);
    }
    // The row type is erased on the way in: the renderers only ever reach a row
    // through that dataset's own columns, so nothing downstream needs to know it.
    this.datasets.set(dataset.key, dataset as unknown as ExportDataset<never>);
  }

  /** The key comes off the URL, so an unknown one is a 404, not a crash. */
  get(key: string): ExportDataset<never> {
    const dataset = this.datasets.get(key);
    if (!dataset) throw new NotFoundException(`Nothing called "${key}" can be exported`);
    return dataset;
  }
}
