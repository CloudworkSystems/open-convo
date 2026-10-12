import DeskHost
import DeskHostWebKit
import Foundation
import JavaScriptCore
import XCTest

final class HostBootstrapScriptTests: XCTestCase {
    private struct Observed: Decodable, Equatable {
        let writable: Bool
        let configurable: Bool
        let enumerable: Bool
        let frozen: Bool
        let keys: [String]
        let v: Int
        let connectionId: String
        let generation: Int
        let plainObject: Bool
    }

    private static let inspect = """
    (function () {
      var d = Object.getOwnPropertyDescriptor(window, "trueConvoHostBootstrap");
      if (!d) return "missing";
      var value = d.value;
      return JSON.stringify({
        writable: d.writable, configurable: d.configurable, enumerable: d.enumerable,
        frozen: Object.isFrozen(value), keys: Object.keys(value),
        v: value.v, connectionId: value.connectionId, generation: value.generation,
        plainObject: Object.getPrototypeOf(value) === Object.prototype
      });
    })()
    """

    private func observe(in context: JSContext) throws -> Observed {
        let text = try XCTUnwrap(context.evaluateScript(Self.inspect)?.toString())
        return try JSONDecoder().decode(Observed.self, from: Data(text.utf8))
    }

    private func makeContext() throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("var window = this;")
        return context
    }

    func testValuesComeFromJSONSerializationInsideTheFixedTemplate() throws {
        let script = try HostBootstrapScript(connectionId: "abc123", generation: 4)
        XCTAssertEqual(script.encodedBootstrap, #"{"connectionId":"abc123","generation":4,"v":1}"#)
        XCTAssertTrue(script.source.contains("(\(script.encodedBootstrap));"))
        XCTAssertTrue(script.source.contains("Object.freeze(bootstrap)"))
        XCTAssertFalse(script.source.contains(HostBootstrapScript.globalName + " ="), "no assignment, only defineProperty")
        XCTAssertEqual(script.source.components(separatedBy: script.encodedBootstrap).count, 2, "the JSON appears exactly once")
    }

    func testDefinesFrozenNonWritableNonConfigurableExactObject() throws {
        let context = try makeContext()
        let script = try HostBootstrapScript(connectionId: "51000000-0000-4000-8000-000000000001", generation: 2)
        context.evaluateScript(script.source)
        XCTAssertNil(context.exception)
        let observed = try observe(in: context)
        XCTAssertEqual(observed, Observed(writable: false, configurable: false, enumerable: false, frozen: true,
                                          keys: ["connectionId", "generation", "v"], v: 1,
                                          connectionId: "51000000-0000-4000-8000-000000000001", generation: 2, plainObject: true))
    }

    /// The connection id is opaque host text. Quotes, backslashes, newlines,
    /// a script terminator and a line separator all survive the encoder
    /// unchanged and cannot escape the literal.
    func testHostileConnectionIdIsEscapedByTheEncoder() throws {
        let hostile = "a\"b\\c\nd</script>\u{2028}e'f\u{0000}g"
        let script = try HostBootstrapScript(connectionId: hostile, generation: 7)
        XCTAssertFalse(script.source.contains(hostile))
        let context = try makeContext()
        context.evaluateScript(script.source)
        XCTAssertNil(context.exception)
        let observed = try observe(in: context)
        XCTAssertEqual(observed.connectionId, hostile)
        XCTAssertEqual(observed.generation, 7)
        XCTAssertEqual(observed.keys, ["connectionId", "generation", "v"])
    }

    func testPageCannotReplaceOrExtendTheBootstrap() throws {
        let context = try makeContext()
        context.evaluateScript(try HostBootstrapScript(connectionId: "first", generation: 1).source)
        let attempts = """
        (function () {
          var results = [];
          try { window.trueConvoHostBootstrap = { v: 1, connectionId: "x", generation: 9 }; results.push("assigned"); } catch (e) { results.push("assign-threw"); }
          try { window.trueConvoHostBootstrap.connectionId = "x"; results.push("mutated"); } catch (e) { results.push("mutate-threw"); }
          try { window.trueConvoHostBootstrap.extra = 1; results.push("extended"); } catch (e) { results.push("extend-threw"); }
          try { delete window.trueConvoHostBootstrap; results.push("deleted"); } catch (e) { results.push("delete-threw"); }
          return results.join(",");
        })()
        """
        _ = context.evaluateScript(attempts)
        let observed = try observe(in: context)
        XCTAssertEqual(observed.connectionId, "first")
        XCTAssertEqual(observed.generation, 1)
        XCTAssertEqual(observed.keys, ["connectionId", "generation", "v"])
        XCTAssertNotNil(context.evaluateScript("window.trueConvoHostBootstrap"))
    }

    /// A second script on the same document (which the host never installs)
    /// cannot throw into the page and leaves the first definition in place.
    func testSecondDefinitionOnSameDocumentFailsSilently() throws {
        let context = try makeContext()
        context.evaluateScript(try HostBootstrapScript(connectionId: "first", generation: 1).source)
        context.evaluateScript(try HostBootstrapScript(connectionId: "second", generation: 2).source)
        XCTAssertNil(context.exception)
        XCTAssertEqual(try observe(in: context).connectionId, "first")
    }

    func testFromIssuedConnection() throws {
        let registry = ConnectionRegistry()
        registry.advanceGeneration()
        let connection = registry.issue()
        let script = try HostBootstrapScript(connection: connection)
        XCTAssertEqual(script.connectionId, connection.id)
        XCTAssertEqual(script.generation, 1)
    }
}
