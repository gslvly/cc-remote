import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config'

// 收藏的目录（真实路径），按收藏先后排。最近目录不存，从 listSessions 聚合
const FILE = join(CONFIG_DIR, 'favorites.json')

export class Favorites {
  private paths: string[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []

  list(): readonly string[] {
    return this.paths
  }

  has(path: string) {
    return this.paths.includes(path)
  }

  set(path: string, on: boolean) {
    if (on === this.has(path)) return
    this.paths = on ? [...this.paths, path] : this.paths.filter((p) => p !== path)
    writeFileSync(FILE, JSON.stringify(this.paths, null, 2) + '\n')
  }
}
