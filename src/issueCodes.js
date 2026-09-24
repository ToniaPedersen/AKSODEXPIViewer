// DEXPI issue classification: code registry for the 1.4 verification tool.
// Generated file. Do not hand-edit.
//
// Scope: codes relevant to DEXPI 1.4 / 1.3.1 Proteus files. 2.0-only codes are
// not included.
//
// Each code declares two independent facts:
//
//   needs  — the data the check requires to produce an answer.
//            "schema"               the XSD alone
//            "model"                the information model
//            "profile"              the DISC profile
//            "model+profile"        both
//            "model+profileForDisc" the model, plus the profile if the file claims DISC.
//
//   scope  — which files the check applies to.
//            "all"   any DEXPI file
//            "disc"  only a file that claims the DISC profile.
//
// A check that cannot be evaluated returns "not-evaluated", never "pass".

export const LAYER_LABELS = {
    "SER": "Serialization & schema",
    "MDL": "Effective information model",
    "PRF": "DISC profile — symbols & scope",
    "GEO": "Node placement & geometry"
};

export const ISSUE_CODES = {
    "GEO-ALN-01": {
        "code": "GEO-ALN-01",
        "layer": "GEO",
        "category": "Connection alignment",
        "title": "Connected items not coincident",
        "severity": "major",
        "needs": "model",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "GEO-ALN-02": {
        "code": "GEO-ALN-02",
        "layer": "GEO",
        "category": "Connection alignment",
        "title": "Zero-length connector",
        "severity": "major",
        "needs": "model",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "GEO-ALN-03": {
        "code": "GEO-ALN-03",
        "layer": "GEO",
        "category": "Connection alignment",
        "title": "Duplicate ports co-located",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Connection endpoints resolved from the model",
        "implemented": false
    },
    "GEO-DIR-01": {
        "code": "GEO-DIR-01",
        "layer": "GEO",
        "category": "Approach direction",
        "title": "Connection approaches at a direction the node forbids",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/NodePosition.Directions",
        "implemented": false
    },
    "GEO-GRD-01": {
        "code": "GEO-GRD-01",
        "layer": "GEO",
        "category": "Grid alignment",
        "title": "SymbolUsage position not on the grid",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Grid unit declared by the profile rule set (currently 1.0, zero tolerance)",
        "implemented": true
    },
    "GEO-GRD-02": {
        "code": "GEO-GRD-02",
        "layer": "GEO",
        "category": "Grid alignment",
        "title": "Node position not on the grid",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Grid unit declared by the profile rule set (currently 1.0, zero tolerance)",
        "implemented": true
    },
    "GEO-NCT-01": {
        "code": "GEO-NCT-01",
        "layer": "GEO",
        "category": "Node counts",
        "title": "Node referenced by no connection",
        "severity": "minor",
        "needs": "model",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "GEO-NCT-02": {
        "code": "GEO-NCT-02",
        "layer": "GEO",
        "category": "Node counts",
        "title": "Connection count outside the node's declared bounds",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/NodePosition — MinCount and MaxCount",
        "implemented": false
    },
    "GEO-NCT-04": {
        "code": "GEO-NCT-04",
        "layer": "GEO",
        "category": "Node counts",
        "title": "Component declares more ports than are referenced",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/NodePosition MinCount and MaxCount",
        "implemented": false
    },
    "GEO-NPS-01": {
        "code": "GEO-NPS-01",
        "layer": "GEO",
        "category": "Node position",
        "title": "Node not at a connection point of the placed symbol",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "SymbolVariant.NodePositions — Position",
        "implemented": false
    },
    "GEO-NPS-02": {
        "code": "GEO-NPS-02",
        "layer": "GEO",
        "category": "Node position",
        "title": "Node position cannot be checked — no symbol placed",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "SymbolVariant.NodePositions — Position",
        "implemented": false
    },
    "GEO-NPS-03": {
        "code": "GEO-NPS-03",
        "layer": "GEO",
        "category": "Node position",
        "title": "Profile symbol declares no connection points",
        "severity": "minor",
        "needs": "model",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "GEO-NTY-01": {
        "code": "GEO-NTY-01",
        "layer": "GEO",
        "category": "Node type usage",
        "title": "Piping node used by a non-piping connection",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/NodePosition.Type (Piping, Instrumentation, Label, Auxiliary)",
        "implemented": false
    },
    "GEO-NTY-03": {
        "code": "GEO-NTY-03",
        "layer": "GEO",
        "category": "Node type usage",
        "title": "Instrumentation node used by a piping connection",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/NodePosition.Type (Piping, Instrumentation, Label, Auxiliary)",
        "implemented": false
    },
    "GEO-SNS-01": {
        "code": "GEO-SNS-01",
        "layer": "GEO",
        "category": "Sensing location",
        "title": "Sensing location not coincident with the measured item",
        "severity": "minor",
        "needs": "model",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "GEO-SNS-02": {
        "code": "GEO-SNS-02",
        "layer": "GEO",
        "category": "Sensing location",
        "title": "Sensing location references an impermissible object type",
        "severity": "major",
        "needs": "model",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-CLS-01": {
        "code": "MDL-CLS-01",
        "layer": "MDL",
        "category": "Class usage",
        "title": "Class not defined in the model",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-CLS-02": {
        "code": "MDL-CLS-02",
        "layer": "MDL",
        "category": "Class usage",
        "title": "Abstract class used as an object class",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-CLS-03": {
        "code": "MDL-CLS-03",
        "layer": "MDL",
        "category": "Class usage",
        "title": "Class contradicts other evidence in the file",
        "severity": "major",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "DEXPI 1.4 XMI classes / Plant.xml + Core.xml classes",
        "implemented": true
    },
    "MDL-CLS-04": {
        "code": "MDL-CLS-04",
        "layer": "MDL",
        "category": "Class usage",
        "title": "Type URI unresolvable or echoes the class name",
        "severity": "minor",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "DEXPI 1.4 XMI classes / Plant.xml + Core.xml classes",
        "implemented": true
    },
    "MDL-CMP-01": {
        "code": "MDL-CMP-01",
        "layer": "MDL",
        "category": "Composition",
        "title": "Components property not defined for the parent class",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-CMP-02": {
        "code": "MDL-CMP-02",
        "layer": "MDL",
        "category": "Composition",
        "title": "Child class not permitted by the composition property",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-CMP-03": {
        "code": "MDL-CMP-03",
        "layer": "MDL",
        "category": "Composition",
        "title": "Required sub-component missing",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-CMP-04": {
        "code": "MDL-CMP-04",
        "layer": "MDL",
        "category": "Composition",
        "title": "Container present but empty",
        "severity": "minor",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-CYC-01": {
        "code": "MDL-CYC-01",
        "layer": "MDL",
        "category": "Cyclic dependency",
        "title": "Cyclic dependency",
        "severity": "major",
        "needs": "model",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-MUL-01": {
        "code": "MDL-MUL-01",
        "layer": "MDL",
        "category": "Multiplicity",
        "title": "Multiplicity bound violated",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": "Declared lower and upper multiplicity on the property",
        "implemented": true
    },
    "MDL-MUL-03": {
        "code": "MDL-MUL-03",
        "layer": "MDL",
        "category": "Multiplicity",
        "title": "Opposite multiplicity exceeded",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-MUL-04": {
        "code": "MDL-MUL-04",
        "layer": "MDL",
        "category": "Multiplicity",
        "title": "Duplicate entry in a unique property",
        "severity": "minor",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-PRP-01": {
        "code": "MDL-PRP-01",
        "layer": "MDL",
        "category": "Properties",
        "title": "Property not defined on the class or an ancestor",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-PRP-02": {
        "code": "MDL-PRP-02",
        "layer": "MDL",
        "category": "Properties",
        "title": "Property value type does not match the declared type",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-PRP-03": {
        "code": "MDL-PRP-03",
        "layer": "MDL",
        "category": "Properties",
        "title": "Required property absent",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-PRP-04": {
        "code": "MDL-PRP-04",
        "layer": "MDL",
        "category": "Properties",
        "title": "Property value outside its declared constraint",
        "severity": "minor",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-PRP-05": {
        "code": "MDL-PRP-05",
        "layer": "MDL",
        "category": "Properties",
        "title": "Standard namespace claimed for a non-standard attribute",
        "severity": "minor",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-PRP-06": {
        "code": "MDL-PRP-06",
        "layer": "MDL",
        "category": "Properties",
        "title": "Serialized attribute name does not reduce to a model property",
        "severity": "minor",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-REF-01": {
        "code": "MDL-REF-01",
        "layer": "MDL",
        "category": "References & endpoints",
        "title": "Reference target absent from the file",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-REF-02": {
        "code": "MDL-REF-02",
        "layer": "MDL",
        "category": "References & endpoints",
        "title": "Target class not permitted by the reference property",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "MDL-REF-03": {
        "code": "MDL-REF-03",
        "layer": "MDL",
        "category": "References & endpoints",
        "title": "Endpoint role violated",
        "severity": "major",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-REF-04": {
        "code": "MDL-REF-04",
        "layer": "MDL",
        "category": "References & endpoints",
        "title": "Endpoint class cannot be determined",
        "severity": "minor",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-REF-05": {
        "code": "MDL-REF-05",
        "layer": "MDL",
        "category": "References & endpoints",
        "title": "Object never participates where the model expects it to",
        "severity": "minor",
        "needs": "model+profileForDisc",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "MDL-TAG-01": {
        "code": "MDL-TAG-01",
        "layer": "MDL",
        "category": "Identification",
        "title": "Taggable object carries no identifier",
        "severity": "minor",
        "needs": "model",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "PRF-EXT-01": {
        "code": "PRF-EXT-01",
        "layer": "MDL",
        "category": "Properties",
        "title": "Extension property used off its baseType",
        "severity": "major",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "ClassExtension nodes, SymbolExtension.AllowedTypeCodes, MetaData/rdl_uri",
        "implemented": true
    },
    "PRF-EXT-02": {
        "code": "PRF-EXT-02",
        "layer": "MDL",
        "category": "Properties",
        "title": "Extension attribute emitted without the vendor namespace",
        "severity": "minor",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "ClassExtension nodes, SymbolExtension.AllowedTypeCodes, MetaData/rdl_uri",
        "implemented": false
    },
    "PRF-EXT-03": {
        "code": "PRF-EXT-03",
        "layer": "PRF",
        "category": "Symbol usage",
        "title": "Type code outside the symbol's AllowedTypeCodes",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "ClassExtension nodes, SymbolExtension.AllowedTypeCodes, MetaData/rdl_uri",
        "implemented": false
    },
    "PRF-EXT-04": {
        "code": "PRF-EXT-04",
        "layer": "MDL",
        "category": "Class usage",
        "title": "Object rdl_uri disagrees with the profile class it claims",
        "severity": "minor",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "ClassExtension nodes, SymbolExtension.AllowedTypeCodes, MetaData/rdl_uri",
        "implemented": false
    },
    "PRF-LBL-01": {
        "code": "PRF-LBL-01",
        "layer": "PRF",
        "category": "Label templates",
        "title": "Label references an attribute the symbol does not permit",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/SymbolVariant — LabelTemplate attribute allow-list",
        "implemented": true
    },
    "PRF-LBL-02": {
        "code": "PRF-LBL-02",
        "layer": "PRF",
        "category": "Label templates",
        "title": "Label is literal text with no attribute template",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "SymbolVariant.LabelTemplates — Index, Text and the attributes each names",
        "implemented": true
    },
    "PRF-LBL-04": {
        "code": "PRF-LBL-04",
        "layer": "PRF",
        "category": "Label templates",
        "title": "Label template index or position not defined by the variant",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "SymbolVariant.LabelTemplates — Index, Text and the attributes each names",
        "implemented": false
    },
    "PRF-MAP-01": {
        "code": "PRF-MAP-01",
        "layer": "MDL",
        "category": "Class usage",
        "title": "1.4 class has no counterpart by name",
        "severity": "minor",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "MetaData/rdl_uri on profile classes, plus the version map table",
        "implemented": false
    },
    "PRF-MAP-02": {
        "code": "PRF-MAP-02",
        "layer": "MDL",
        "category": "Class usage",
        "title": "RDL URI does not resolve against the profile",
        "severity": "minor",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "MetaData/rdl_uri on profile classes, plus the version map table",
        "implemented": false
    },
    "PRF-MAP-03": {
        "code": "PRF-MAP-03",
        "layer": "MDL",
        "category": "Class usage",
        "title": "Custom wrapper does not match the family its URI resolves to",
        "severity": "major",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "MetaData/rdl_uri on profile classes, plus the version map table",
        "implemented": false
    },
    "PRF-MAP-04": {
        "code": "PRF-MAP-04",
        "layer": "MDL",
        "category": "Class usage",
        "title": "Class mapped by name across a version rename",
        "severity": "major",
        "needs": "model+profile",
        "scope": "disc",
        "drivenBy": "MetaData/rdl_uri on profile classes, plus the version map table",
        "implemented": false
    },
    "PRF-MAP-05": {
        "code": "PRF-MAP-05",
        "layer": "PRF",
        "category": "1.4 → DISC mapping",
        "title": "1.4 Shape class used where 2.0 expects SymbolUsage",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "MetaData/rdl_uri on profile classes, plus the version map table",
        "implemented": false
    },
    "PRF-MAP-06": {
        "code": "PRF-MAP-06",
        "layer": "PRF",
        "category": "1.4 → DISC mapping",
        "title": "Serialized symbol name does not reduce to a profile symbol",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "MetaData/rdl_uri on profile classes, plus the version map table",
        "implemented": false
    },
    "PRF-SCP-01": {
        "code": "PRF-SCP-01",
        "layer": "PRF",
        "category": "DISC scope",
        "title": "Class outside the DISC AllowedClasses list",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/UsageConstraint — AllowedClasses and AllowedProperties",
        "implemented": true
    },
    "PRF-SCP-02": {
        "code": "PRF-SCP-02",
        "layer": "PRF",
        "category": "DISC scope",
        "title": "Property outside the DISC AllowedProperties list",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/UsageConstraint — AllowedClasses and AllowedProperties",
        "implemented": true
    },
    "PRF-SYM-01": {
        "code": "PRF-SYM-01",
        "layer": "PRF",
        "category": "Symbol usage",
        "title": "Symbol not in the SymbolCatalogue",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/SymbolCatalogue and each Symbol's MetaData/usage",
        "implemented": true
    },
    "PRF-SYM-02": {
        "code": "PRF-SYM-02",
        "layer": "PRF",
        "category": "Symbol usage",
        "title": "Symbol used for a class its usage does not cover",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/SymbolCatalogue and each Symbol's MetaData/usage",
        "implemented": true
    },
    "PRF-SYM-03": {
        "code": "PRF-SYM-03",
        "layer": "PRF",
        "category": "Symbol usage",
        "title": "Drawn object places no symbol",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/SymbolCatalogue and each Symbol's MetaData/usage",
        "implemented": false
    },
    "PRF-SYM-04": {
        "code": "PRF-SYM-04",
        "layer": "PRF",
        "category": "Symbol usage",
        "title": "Placeholder or disabled symbol name emitted",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/SymbolCatalogue and each Symbol's MetaData/usage",
        "implemented": false
    },
    "PRF-TRN-01": {
        "code": "PRF-TRN-01",
        "layer": "PRF",
        "category": "Symbol transforms",
        "title": "Transform applied where the profile forbids it",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "Profile/Symbol — RotationAllowed, MirroringAllowed, ResizingXAllowed, ResizingYAllowed",
        "implemented": false
    },
    "PRF-TRN-05": {
        "code": "PRF-TRN-05",
        "layer": "PRF",
        "category": "Symbol transforms",
        "title": "Zero or negative scale",
        "severity": "major",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "SymbolVariant RotationAllowed / MirroringAllowed / ResizingXAllowed / ResizingYAllowed",
        "implemented": true
    },
    "PRF-VAR-01": {
        "code": "PRF-VAR-01",
        "layer": "PRF",
        "category": "Variant selection",
        "title": "Variant condition not satisfied",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "SymbolVariant Condition (PropertyValueCondition) and VariantNumber",
        "implemented": false
    },
    "PRF-VAR-02": {
        "code": "PRF-VAR-02",
        "layer": "PRF",
        "category": "Variant selection",
        "title": "No variant selected or VariantNumber out of range",
        "severity": "minor",
        "needs": "profile",
        "scope": "disc",
        "drivenBy": "SymbolVariant Condition (PropertyValueCondition) and VariantNumber",
        "implemented": false
    },
    "SER-CNT-01": {
        "code": "SER-CNT-01",
        "layer": "SER",
        "category": "Declared counts",
        "title": "Declared count disagrees with actual children",
        "severity": "minor",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-FMT-01": {
        "code": "SER-FMT-01",
        "layer": "SER",
        "category": "File format",
        "title": "File is not well-formed XML",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "SER-FMT-02": {
        "code": "SER-FMT-02",
        "layer": "SER",
        "category": "File format",
        "title": "Wrong root element for the declared version",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-FMT-04": {
        "code": "SER-FMT-04",
        "layer": "SER",
        "category": "File format",
        "title": "Declared version does not match the content",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-IDN-01": {
        "code": "SER-IDN-01",
        "layer": "SER",
        "category": "Identity & references",
        "title": "Duplicate id within the file",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-IDN-02": {
        "code": "SER-IDN-02",
        "layer": "SER",
        "category": "Identity & references",
        "title": "id does not match the ID pattern",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-IDN-03": {
        "code": "SER-IDN-03",
        "layer": "SER",
        "category": "Identity & references",
        "title": "Reference does not resolve inside the file",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "SER-IDN-04": {
        "code": "SER-IDN-04",
        "layer": "SER",
        "category": "Identity & references",
        "title": "Name collision in one scope",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-REQ-01": {
        "code": "SER-REQ-01",
        "layer": "SER",
        "category": "Required content",
        "title": "Required attribute missing",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-REQ-02": {
        "code": "SER-REQ-02",
        "layer": "SER",
        "category": "Required content",
        "title": "Required child element missing",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-STR-01": {
        "code": "SER-STR-01",
        "layer": "SER",
        "category": "Document structure",
        "title": "Element not permitted in this parent",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-STR-02": {
        "code": "SER-STR-02",
        "layer": "SER",
        "category": "Document structure",
        "title": "Element order violates the schema sequence",
        "severity": "minor",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "SER-STR-03": {
        "code": "SER-STR-03",
        "layer": "SER",
        "category": "Document structure",
        "title": "Foreign element or attribute",
        "severity": "minor",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-VAL-01": {
        "code": "SER-VAL-01",
        "layer": "SER",
        "category": "Lexical values",
        "title": "Value does not match its lexical pattern",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-VAL-02": {
        "code": "SER-VAL-02",
        "layer": "SER",
        "category": "Lexical values",
        "title": "Empty or placeholder reference string",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": false
    },
    "SER-VAL-03": {
        "code": "SER-VAL-03",
        "layer": "SER",
        "category": "Lexical values",
        "title": "Value not lexically valid for its datatype",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    },
    "SER-VAL-04": {
        "code": "SER-VAL-04",
        "layer": "SER",
        "category": "Lexical values",
        "title": "Enumeration literal not declared",
        "severity": "major",
        "needs": "schema",
        "scope": "all",
        "drivenBy": null,
        "implemented": true
    }
};

export const ALL_CODES = Object.keys(ISSUE_CODES);

/** Codes that need the profile loaded before they can say anything. */
export const PROFILE_CODES = ALL_CODES.filter(
    c => ISSUE_CODES[c].needs === "profile" || ISSUE_CODES[c].needs === "model+profile");

/** Codes that are only meaningful for a file that claims the DISC profile. */
export const DISC_SCOPED_CODES = ALL_CODES.filter(c => ISSUE_CODES[c].scope === "disc");

/** Codes whose name resolution degrades when a DISC file is checked without a profile. */
export const UNION_MODEL_CODES = ALL_CODES.filter(
    c => ISSUE_CODES[c].needs === "model+profileForDisc");

export const UNIMPLEMENTED_CODES = ALL_CODES.filter(c => !ISSUE_CODES[c].implemented);

export function severityOf(code) {
    return ISSUE_CODES[code] ? ISSUE_CODES[code].severity : null;
}

/**
 * Three-state result for one code.
 *
 * @param {string} code
 * @param {object} ctx
 * @param {boolean} ctx.hasProfile       a DISC profile was loaded alongside the file
 * @param {boolean} ctx.fileUsesProfile  the file itself claims the DISC profile
 * @param {number}  ctx.findingCount     findings emitted for this code
 * @returns {"pass"|"fail"|"not-evaluated"}
 */
export function codeState(code, { hasProfile, fileUsesProfile, findingCount }) {
    const meta = ISSUE_CODES[code];
    if (!meta) return "not-evaluated";
    if (!meta.implemented) return "not-evaluated";

    // File does not claim DISC, so DISC-scoped rules do not apply.
    if (meta.scope === "disc" && !fileUsesProfile) return "not-evaluated";

    // Required data is missing.
    if ((meta.needs === "profile" || meta.needs === "model+profile") && !hasProfile)
        return "not-evaluated";

    // Profile supplies part of the class universe; without it, a DISC file's
    // class names cannot be resolved.
    if (meta.needs === "model+profileForDisc" && fileUsesProfile && !hasProfile)
        return "not-evaluated";

    return findingCount > 0 ? "fail" : "pass";
}
