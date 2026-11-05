// One-line "Suggestion:" shown under each validation finding (Validation tab,
// Issues tab, Folder tab), as in DEXPIViewer. Built from the finding's code and
// message only - no XML parsing - so it is cheap for every row. The
// "Suggest..." dialog (suggestPrompt.js) stays the place for a worked diff.
//
// Rules are checked top to bottom; the first whose code matches (and whose
// `when` test, if any, matches the message) gives the text. Values quoted in
// the message are pulled in with q(n) so the line names the object, attribute
// or value concerned.

// The n-th "double-quoted" piece of the message (0-based), or a fallback.
function quoted(message, n, fallback = "") {
    const all = [...String(message || "").matchAll(/"([^"]*)"/g)].map(m => m[1]);
    return all[n] ?? fallback;
}

const RULES = [
    // ---- Serialization & schema (XSD + structure) ---------------------------
    { code: "SER-IDN-01", text: () => "Give each element its own ID: rename the duplicate and update every ItemID / FromID / ToID that should point at the renamed element." },
    { code: "SER-IDN-02", text: () => "Make the ID a valid xs:ID: start with a letter or \"_\", and use only letters, digits, \"_\", \"-\" and \".\" (no spaces or leading digits)." },
    { code: "SER-IDN-03", when: m => /FromNode|ToNode|FlowIn|FlowOut|node index|Node index/i.test(m), text: () => "Set the node index to an existing Node of the target's ConnectionPoints (indexed from 0), or add the missing Node." },
    { code: "SER-IDN-03", when: m => /TagName=/.test(m), text: () => "Correct the Association TagName to the TagName of an object in the file, or reference the object by ItemID instead." },
    { code: "SER-IDN-03", when: m => /PersistentID/.test(m), text: () => "Correct PersistentIDIdentifier/Context to a PersistentID present in the file, or reference the object by ItemID instead." },
    { code: "SER-IDN-03", text: m => `Correct the reference to the ID of an object in this file${quoted(m, 0) ? ` (no element has ID "${quoted(m, 0)}")` : ""}, or remove it if the object is not part of this drawing.` },
    { code: "SER-IDN-04", text: () => "Keep one PersistentID per Context on the element: remove the duplicate, or give it its own Context." },
    { code: "SER-REQ-01", text: m => `Add the required attribute${/attribute '([^']+)'/.test(m) ? ` '${/attribute '([^']+)'/.exec(m)[1]}'` : ""} with a valid value.` },
    { code: "SER-REQ-02", when: m => /GenericAttributes/.test(m), text: () => "Add at least one <GenericAttribute> to the GenericAttributes set, or remove the empty set." },
    { code: "SER-REQ-02", text: () => "Add the missing child element named in the message, in the order the Proteus 4.1.1 schema expects." },
    { code: "SER-STR-01", text: () => "Move the element to a parent that allows it, or remove it. The message lists the elements the schema expects at this position." },
    { code: "SER-STR-03", text: m => `Remove the attribute${/attribute '([^']+)'/.test(m) ? ` '${/attribute '([^']+)'/.exec(m)[1]}'` : ""}, or move its value into a GenericAttribute.` },
    { code: "SER-VAL-01", when: m => /stray whitespace|non-breaking space/i.test(m), text: m => `Trim the GenericAttribute Name${quoted(m, 0) ? ` to "${quoted(m, 0).trim()}"` : ""} and fix the export mapping that adds the extra space.` },
    { code: "SER-VAL-01", text: () => "Write the value in the form the schema expects for this attribute (see the allowed pattern or values in the message)." },
    { code: "SER-VAL-03", text: () => "Write the value in its datatype's lexical form, e.g. a number with \".\" as decimal separator, true/false for a boolean, no empty string for a number." },
    { code: "SER-VAL-04", text: m => `Replace "${quoted(m, 0) || "the value"}" with one of the listed values (or leave it empty if the value is not known).` },
    { code: "SER-CNT-01", text: () => "Set the GenericAttributes Number to the number of GenericAttribute elements it contains." },
    { code: "SER-FMT-02", text: () => "Use the root element the declared schema version expects (PlantModel for Proteus 4.1.1), with the matching namespace." },
    { code: "SER-FMT-04", when: m => /mixes both/.test(m), text: () => "Convert the file to one DEXPI version: replace the classes listed for the other version, then set ApplicationVersion to match." },
    { code: "SER-FMT-04", text: () => "Set ApplicationVersion to 1.4 (the file uses 1.4-only classes), or replace those classes with their 1.3.1 equivalents." },

    // ---- Effective information model ----------------------------------------
    { code: "MDL-CLS-01", when: m => /TypeURIAssignmentClass/.test(m), text: () => "Set TypeURIAssignmentClass to the rdl_uri of a class extension in the DiscProfile.xml, or add that class extension to the profile." },
    { code: "MDL-CLS-01", text: m => `Replace ComponentClass "${quoted(m, 0) || "…"}" with a DEXPI 1.4 or DiscProfile.xml class. A vendor class becomes Custom<BaseClass> with TypeName/TypeURIAssignmentClass saying what it is.` },
    { code: "MDL-CLS-02", text: () => "Use a concrete leaf subclass of this abstract class (ComponentClass and ComponentClassURI)." },
    { code: "MDL-CLS-03", text: () => "Make ComponentClass agree with the rest of the file (symbol, ComponentClassURI, attributes): change it to the class the object really is." },
    { code: "MDL-CLS-04", text: () => "Add a TypeURIAssignmentClass GenericAttribute whose Value is the rdl_uri of the DiscProfile.xml class the Custom object really is." },
    { code: "MDL-CLS-05", when: m => /ComponentClassURI/.test(m), text: () => "Add ComponentClassURI with the RDL URI of the ComponentClass." },
    { code: "MDL-CLS-05", when: m => /InformationFlow/.test(m), text: () => "Add ComponentClass=\"SignalLineFunction\" (or MeasuringLineFunction / SignalConveyingFunction) and its ComponentClassURI to the InformationFlow." },
    { code: "MDL-CLS-05", text: () => "Add ComponentClass and ComponentClassURI naming the DEXPI class of the element." },
    { code: "MDL-CMP-01", text: () => "Move the nested element out to the parent the message names; a signal line cannot contain objects. Keep it linked with an Association instead." },
    { code: "MDL-CMP-02", when: m => /TransmissionSystem/.test(m), text: () => "Nest the TransmissionSystem directly in its Equipment, and give that Equipment <Association Type=\"is driven by\" ItemID=\"{TransmissionSystem ID}\"/>." },
    { code: "MDL-CMP-02", when: m => /ProcessVesselComponent|Vessel/.test(m), text: () => "Move the vessel component into the Vessel <Equipment> as a direct <Component> child." },
    { code: "MDL-CMP-02", text: () => "Move the child to a parent whose composition property allows its class, or change the child's class." },
    { code: "MDL-CMP-03", when: m => /ConnectionPoints\/Node/.test(m), text: () => "Add <ConnectionPoints> with a Default/Origin <Node/> first, then one <Node> with a Position per connection." },
    { code: "MDL-CMP-03", when: m => /TransmissionSystem/.test(m), text: m => `Add <Association Type="${quoted(m, 0) || "is driven by"}" ItemID="…"/> pointing at the driving/driven <Equipment>.` },
    { code: "MDL-CMP-03", text: () => "Add the required sub-component named in the message." },
    { code: "MDL-CYC-01", text: () => "Break the loop: point the reference at the object it should reach instead of back at itself or an object that refers to it." },
    { code: "MDL-MUL-01", text: () => "Keep only as many values as the model allows: remove the extra GenericAttribute(s) for this property." },
    { code: "MDL-MUL-03", text: () => "Keep the one link that is right and remove the other(s), together with the reverse Association on each removed object." },
    { code: "MDL-PRP-01", when: m => /must be written as/.test(m), text: m => `Rename the attribute to "${quoted(m, 2) || `${quoted(m, 1)}AssignmentClass`}".` },
    { code: "MDL-PRP-01", when: m => /no AttributeURI/.test(m), text: () => "Add the AttributeURI (the property's rdl_uri) so the attribute can be matched to the model and profile." },
    { code: "MDL-PRP-01", text: () => "Use an attribute defined for this class (check the AttributeURI), move it to a non-DEXPI GenericAttributes set, or remove it." },
    { code: "MDL-PRP-02", text: () => "Write it as a PhysicalQuantity: Format=\"double\", a numeric Value, Units, and Type naming the unit type (e.g. PressureGaugeUnit)." },
    { code: "MDL-PRP-03", text: () => "Add the missing attribute(s) named in the message to that GenericAttributes set." },
    { code: "MDL-PRP-05", text: () => "Move the attribute out of the DEXPI namespace: give it a non-DEXPI AttributeURI and put it in a vendor GenericAttributes set, or use the DEXPI property it stands for." },
    { code: "MDL-REF-03", when: m => /InformationFlow ComponentClass/.test(m), text: () => "Set the InformationFlow ComponentClass to SignalLineFunction, MeasuringLineFunction or SignalConveyingFunction." },
    { code: "MDL-REF-03", text: () => "Point the signal line's Source/Target at an object of an allowed class (e.g. ProcessInstrumentationFunction, ProcessSignalGeneratingFunction or ActuatingFunction), not the equipment or valve itself." },
    { code: "MDL-REF-04", when: m => /no ComponentClass/.test(m), text: () => "Add ComponentClass and ComponentClassURI to the referenced object so its type can be checked." },
    { code: "MDL-REF-04", text: () => "Correct the \"has logical start/end\" ItemID to an object in the file." },
    { code: "MDL-REF-05", text: () => "Connect the function to a signal line: an InformationFlow with \"has logical start\"/\"has logical end\" pointing at it, and the reverse Association on this object." },
    { code: "MDL-REF-07", when: m => /at most 1 is allowed/.test(m), text: () => "Keep one reference and remove the others." },
    { code: "MDL-REF-07", when: m => /has no \w+ reference/.test(m), text: () => "Add the missing reference (an Association, or the Connection FromID/ToID for a piping segment) to the object it belongs to." },
    { code: "MDL-REF-07", text: () => "Point the reference at an existing object of the class the model expects." },

    // ---- DISC profile --------------------------------------------------------
    { code: "PRF-SCP-01", text: () => "Change ComponentClass (and ComponentClassURI) to a class in the DISC AllowedClasses list, or to Custom<BaseClass> with TypeName/TypeURIAssignmentClass." },
    { code: "PRF-SCP-02", when: m => /only allowed on CustomObject/.test(m), text: () => "Remove the attribute, or change the object to a Custom<BaseClass> class that may carry it." },
    { code: "PRF-SCP-02", text: () => "Use a property the DISC profile allows for this class, move the attribute to a non-DEXPI GenericAttributes set, or remove it." },
    { code: "PRF-EXT-01", text: () => "Use the attribute only on the class its profile extension is declared for, or set the object's TypeURIAssignmentClass to that class." },
    { code: "PRF-EXT-04", text: () => "Make ComponentClass and ComponentClassURI name the same class." },
    { code: "PRF-LBL-01", text: () => "Set the Label Text's DependantAttribute to one of the attributes the symbol's LabelTemplates use (listed in the message)." },
    { code: "PRF-LBL-02", text: () => "Replace the literal Label text with a TextStringFormatSpecification that references the attribute it shows, or give the Label a symbol that defines the label." },
    { code: "PRF-SYM-01", text: () => "Give the ShapeCatalogue entry a SymbolRegistrationNumberAssignmentClass with a symbol the DiscProfile.xml declares (e.g. ND0006)." },
    { code: "PRF-SYM-02", text: () => "Use the symbol registered for this class, or change ComponentClass to the class the symbol is meant for." },
    { code: "PRF-TRN-05", text: () => "Add <Scale X=\"1\" Y=\"1\" Z=\"1\"/> (or the intended size) to the symbol placement." },

    // ---- Geometry ------------------------------------------------------------
    { code: "GEO-ALN-01", text: () => "Move the CenterLine ends and the components' nodes so each meets the next at the same X/Y, or split the CenterLine at the component." },
    { code: "GEO-ALN-02", text: () => "Remove the zero-length CenterLine, or give it its real end coordinates." },
    { code: "GEO-GRD-01", text: () => "Snap the symbol position to the diagram grid." },
    { code: "GEO-GRD-02", text: () => "Snap the node position to the diagram grid." },
    { code: "GEO-MDL-01", text: () => "Point the connector end (ID and node) at the object type the message expects for this function." },
    { code: "GEO-NCT-01", text: () => "Connect the object: put one of its nodes at the same X/Y as a CenterLine end of the line it sits on, and reference it from that segment's Connection." },
];

/** Short fix advice for a finding ({ code, message }), or null when none fits. */
export function suggestedCorrectionFor(issue) {
    const code = issue?.code || "";
    const message = issue?.message || "";
    for (const rule of RULES) {
        if (rule.code !== code) continue;
        if (rule.when && !rule.when(message)) continue;
        return rule.text(message);
    }
    return null;
}
