import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const PROJECT_ROOT = process.cwd();
const RULES_PATH = path.join(PROJECT_ROOT, "rules.json");

export interface SkuMappings {
  Pristine: string;
  Excellent: string;
  "Very Good": string;
}

export interface ReebeloRules {
  conditionMapping: Record<string, string[]>;
  batteryPolicy: string;
  simPolicy: string;
}

export interface BackmarketRules {
  conditionMapping: Record<string, string[]>;
  simPolicy: string;
}

export interface AmazonRefurbishedRules {
  conditionMapping: Record<string, string[]>;
  excludePristine: boolean;
  excludeVeryGood: boolean;
  rejectBonusAccessories: boolean;
  rejectAustralianVersion: boolean;
  rejectPreOrder: boolean;
  maxWarrantyMonths: number;
}

export interface AmazonBrandNewRules {
  rejectBonusAccessories: boolean;
  rejectAustralianVersion: boolean;
  rejectPreOrder: boolean;
  rejectConditionLabels: boolean;
  maxWarrantyYears: number;
}

export interface CategoryRules {
  skuMappings?: SkuMappings;
  stores: {
    reebelo?: ReebeloRules;
    backmarket?: BackmarketRules;
    amazon?: AmazonRefurbishedRules | AmazonBrandNewRules;
    [store: string]: any;
  };
}

export type RulesConfig = Record<string, CategoryRules>;

const defaultRules: RulesConfig = {
  "MAPPING REFURBISHED": {
    "skuMappings": {
      "Pristine": "-VR-ASN-AU",
      "Excellent": "-RD-VR-EXD-AU",
      "Very Good": "-VGC-AU"
    },
    "stores": {
      "reebelo": {
        "conditionMapping": {
          "Pristine": ["Premium", "Pristine"],
          "Excellent": ["Excellent"]
        },
        "batteryPolicy": "Standard Only",
        "simPolicy": "Physical Only"
      },
      "backmarket": {
        "conditionMapping": {
          "Pristine": ["Excellent"],
          "Excellent": ["Good"]
        },
        "simPolicy": "Physical Only"
      },
      "amazon": {
        "conditionMapping": {
          "Excellent": ["Excellent", "Renewed"]
        },
        "excludePristine": true,
        "excludeVeryGood": true,
        "rejectBonusAccessories": true,
        "rejectAustralianVersion": true,
        "rejectPreOrder": true,
        "maxWarrantyMonths": 6
      }
    }
  },
  "MAPPING BRAND NEW": {
    "stores": {
      "amazon": {
        "rejectBonusAccessories": true,
        "rejectAustralianVersion": true,
        "rejectPreOrder": true,
        "rejectConditionLabels": true,
        "maxWarrantyYears": 1
      }
    }
  },
  "MAPPING BRAND NEW Laptop": {
    "stores": {
      "amazon": {
        "rejectBonusAccessories": true,
        "rejectAustralianVersion": true,
        "rejectPreOrder": true,
        "rejectConditionLabels": true,
        "maxWarrantyYears": 1
      }
    }
  },
  "MAPPING BRAND NEW Lens dan Camera": {
    "stores": {
      "amazon": {
        "rejectBonusAccessories": true,
        "rejectAustralianVersion": true,
        "rejectPreOrder": true,
        "rejectConditionLabels": true,
        "maxWarrantyYears": 1
      }
    }
  }
};

export function loadRules(): RulesConfig {
  try {
    if (fs.existsSync(RULES_PATH)) {
      const data = fs.readFileSync(RULES_PATH, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    logger.warn(`Failed to read rules.json: ${(err as Error).message}. Using default rules.`);
  }
  return defaultRules;
}

export function saveRules(rules: RulesConfig): boolean {
  try {
    fs.writeFileSync(RULES_PATH, JSON.stringify(rules, null, 2), "utf-8");
    return true;
  } catch (err) {
    logger.error(`Failed to save rules.json: ${(err as Error).message}`);
    return false;
  }
}
