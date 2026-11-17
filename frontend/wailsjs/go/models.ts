export namespace ai {
	
	export class CleanableItem {
	    name: string;
	    path: string;
	    size: number;
	    safety: string;
	    category: string;
	    description: string;
	
	    static createFrom(source: any = {}) {
	        return new CleanableItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.safety = source["safety"];
	        this.category = source["category"];
	        this.description = source["description"];
	    }
	}
	export class AnalysisResult {
	    path: string;
	    name: string;
	    size: number;
	    is_dir: boolean;
	    safety: string;
	    category: string;
	    description: string;
	    recommendation: string;
	    action: string;
	    has_uninstaller: boolean;
	    uninstaller_path: string;
	    matched: boolean;
	    cleanable_items: CleanableItem[];
	    source: string;
	    cached: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AnalysisResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.size = source["size"];
	        this.is_dir = source["is_dir"];
	        this.safety = source["safety"];
	        this.category = source["category"];
	        this.description = source["description"];
	        this.recommendation = source["recommendation"];
	        this.action = source["action"];
	        this.has_uninstaller = source["has_uninstaller"];
	        this.uninstaller_path = source["uninstaller_path"];
	        this.matched = source["matched"];
	        this.cleanable_items = this.convertValues(source["cleanable_items"], CleanableItem);
	        this.source = source["source"];
	        this.cached = source["cached"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class LicenseValidateResult {
	    valid: boolean;
	    expires_at: string;
	    plan: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new LicenseValidateResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.valid = source["valid"];
	        this.expires_at = source["expires_at"];
	        this.plan = source["plan"];
	        this.error = source["error"];
	    }
	}

}

export namespace config {
	
	export class Config {
	    ai_api_key: string;
	    ai_base_url: string;
	    ai_model: string;
	    license_key: string;
	    website_api_url: string;
	    license_valid: boolean;
	    license_expiry?: string;
	    license_plan?: string;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ai_api_key = source["ai_api_key"];
	        this.ai_base_url = source["ai_base_url"];
	        this.ai_model = source["ai_model"];
	        this.license_key = source["license_key"];
	        this.website_api_url = source["website_api_url"];
	        this.license_valid = source["license_valid"];
	        this.license_expiry = source["license_expiry"];
	        this.license_plan = source["license_plan"];
	    }
	}

}

export namespace main {
	
	export class MediaPreview {
	    url: string;
	    kind: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new MediaPreview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.url = source["url"];
	        this.kind = source["kind"];
	        this.name = source["name"];
	    }
	}
	export class ScanResult {
	    root?: scanner.FileNode;
	    total_size: number;
	    file_count: number;
	    dir_count: number;
	    scan_method: string;
	
	    static createFrom(source: any = {}) {
	        return new ScanResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = this.convertValues(source["root"], scanner.FileNode);
	        this.total_size = source["total_size"];
	        this.file_count = source["file_count"];
	        this.dir_count = source["dir_count"];
	        this.scan_method = source["scan_method"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace scanner {
	
	export class FileNode {
	    name: string;
	    path: string;
	    size: number;
	    is_dir: boolean;
	    file_count: number;
	    modified: number;
	    children?: FileNode[];
	
	    static createFrom(source: any = {}) {
	        return new FileNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.is_dir = source["is_dir"];
	        this.file_count = source["file_count"];
	        this.modified = source["modified"];
	        this.children = this.convertValues(source["children"], FileNode);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

