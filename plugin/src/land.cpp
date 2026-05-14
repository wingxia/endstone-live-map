#include "livemap/land.hpp"

#include "livemap/protocol.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

namespace livemap {

namespace {

class JsonValue {
public:
    enum class Type {
        Null,
        Bool,
        Number,
        String,
        Array,
        Object,
    };

    using Array = std::vector<JsonValue>;
    using Object = std::map<std::string, JsonValue>;

    Type type = Type::Null;
    bool bool_value = false;
    double number_value = 0;
    std::string string_value;
    Array array_value;
    Object object_value;

    [[nodiscard]] bool isObject() const { return type == Type::Object; }
    [[nodiscard]] bool isArray() const { return type == Type::Array; }
    [[nodiscard]] bool isString() const { return type == Type::String; }
    [[nodiscard]] bool isBool() const { return type == Type::Bool; }
};

class JsonParser {
public:
    explicit JsonParser(std::string_view source) : source_(source) {}

    JsonValue parse()
    {
        skipWhitespace();
        auto value = parseValue();
        skipWhitespace();
        if (pos_ != source_.size()) {
            throw std::runtime_error("unexpected trailing json data");
        }
        return value;
    }

private:
    JsonValue parseValue()
    {
        skipWhitespace();
        if (pos_ >= source_.size()) {
            throw std::runtime_error("unexpected end of json");
        }
        const char ch = source_[pos_];
        if (ch == '{') {
            return parseObject();
        }
        if (ch == '[') {
            return parseArray();
        }
        if (ch == '"') {
            JsonValue value;
            value.type = JsonValue::Type::String;
            value.string_value = parseString();
            return value;
        }
        if (ch == '-' || std::isdigit(static_cast<unsigned char>(ch)) != 0) {
            return parseNumber();
        }
        if (matchLiteral("true")) {
            JsonValue value;
            value.type = JsonValue::Type::Bool;
            value.bool_value = true;
            return value;
        }
        if (matchLiteral("false")) {
            JsonValue value;
            value.type = JsonValue::Type::Bool;
            value.bool_value = false;
            return value;
        }
        if (matchLiteral("null")) {
            return {};
        }
        throw std::runtime_error("invalid json value");
    }

    JsonValue parseObject()
    {
        expect('{');
        JsonValue value;
        value.type = JsonValue::Type::Object;
        skipWhitespace();
        if (consume('}')) {
            return value;
        }
        while (true) {
            skipWhitespace();
            const auto key = parseString();
            skipWhitespace();
            expect(':');
            value.object_value[key] = parseValue();
            skipWhitespace();
            if (consume('}')) {
                return value;
            }
            expect(',');
        }
    }

    JsonValue parseArray()
    {
        expect('[');
        JsonValue value;
        value.type = JsonValue::Type::Array;
        skipWhitespace();
        if (consume(']')) {
            return value;
        }
        while (true) {
            value.array_value.push_back(parseValue());
            skipWhitespace();
            if (consume(']')) {
                return value;
            }
            expect(',');
        }
    }

    JsonValue parseNumber()
    {
        const auto start = pos_;
        if (source_[pos_] == '-') {
            ++pos_;
        }
        while (pos_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[pos_])) != 0) {
            ++pos_;
        }
        if (pos_ < source_.size() && source_[pos_] == '.') {
            ++pos_;
            while (pos_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[pos_])) != 0) {
                ++pos_;
            }
        }
        if (pos_ < source_.size() && (source_[pos_] == 'e' || source_[pos_] == 'E')) {
            ++pos_;
            if (pos_ < source_.size() && (source_[pos_] == '+' || source_[pos_] == '-')) {
                ++pos_;
            }
            while (pos_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[pos_])) != 0) {
                ++pos_;
            }
        }
        JsonValue value;
        value.type = JsonValue::Type::Number;
        value.number_value = std::stod(std::string(source_.substr(start, pos_ - start)));
        return value;
    }

    std::string parseString()
    {
        expect('"');
        std::string out;
        while (pos_ < source_.size()) {
            const char ch = source_[pos_++];
            if (ch == '"') {
                return out;
            }
            if (ch != '\\') {
                out.push_back(ch);
                continue;
            }
            if (pos_ >= source_.size()) {
                throw std::runtime_error("unterminated json escape");
            }
            const char escaped = source_[pos_++];
            switch (escaped) {
            case '"':
            case '\\':
            case '/':
                out.push_back(escaped);
                break;
            case 'b':
                out.push_back('\b');
                break;
            case 'f':
                out.push_back('\f');
                break;
            case 'n':
                out.push_back('\n');
                break;
            case 'r':
                out.push_back('\r');
                break;
            case 't':
                out.push_back('\t');
                break;
            case 'u':
                appendUnicodeEscape(out);
                break;
            default:
                throw std::runtime_error("invalid json escape");
            }
        }
        throw std::runtime_error("unterminated json string");
    }

    void appendUnicodeEscape(std::string &out)
    {
        if (pos_ + 4 > source_.size()) {
            throw std::runtime_error("short unicode escape");
        }
        unsigned code = 0;
        for (int i = 0; i < 4; ++i) {
            const char ch = source_[pos_++];
            code <<= 4;
            if (ch >= '0' && ch <= '9') {
                code += static_cast<unsigned>(ch - '0');
            }
            else if (ch >= 'a' && ch <= 'f') {
                code += static_cast<unsigned>(ch - 'a' + 10);
            }
            else if (ch >= 'A' && ch <= 'F') {
                code += static_cast<unsigned>(ch - 'A' + 10);
            }
            else {
                throw std::runtime_error("invalid unicode escape");
            }
        }

        if (code <= 0x7F) {
            out.push_back(static_cast<char>(code));
        }
        else if (code <= 0x7FF) {
            out.push_back(static_cast<char>(0xC0 | (code >> 6)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
        }
        else {
            out.push_back(static_cast<char>(0xE0 | (code >> 12)));
            out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
        }
    }

    bool matchLiteral(std::string_view literal)
    {
        if (source_.substr(pos_, literal.size()) != literal) {
            return false;
        }
        pos_ += literal.size();
        return true;
    }

    void skipWhitespace()
    {
        while (pos_ < source_.size() && std::isspace(static_cast<unsigned char>(source_[pos_])) != 0) {
            ++pos_;
        }
    }

    bool consume(char expected)
    {
        if (pos_ < source_.size() && source_[pos_] == expected) {
            ++pos_;
            return true;
        }
        return false;
    }

    void expect(char expected)
    {
        if (!consume(expected)) {
            throw std::runtime_error("unexpected json token");
        }
    }

    std::string_view source_;
    std::size_t pos_ = 0;
};

const JsonValue *objectField(const JsonValue &value, const std::string &key)
{
    if (!value.isObject()) {
        return nullptr;
    }
    const auto it = value.object_value.find(key);
    return it == value.object_value.end() ? nullptr : &it->second;
}

std::string stringField(const JsonValue &value, const std::string &key)
{
    const auto *field = objectField(value, key);
    if (field == nullptr) {
        return {};
    }
    if (field->isString()) {
        return field->string_value;
    }
    if (field->type == JsonValue::Type::Number) {
        std::ostringstream out;
        out << static_cast<int>(field->number_value);
        return out.str();
    }
    return {};
}

bool boolField(const JsonValue &value, const std::string &key)
{
    const auto *field = objectField(value, key);
    return field != nullptr && field->isBool() && field->bool_value;
}

std::vector<std::string> stringArrayField(const JsonValue &value, const std::string &key)
{
    std::vector<std::string> values;
    const auto *field = objectField(value, key);
    if (field == nullptr || !field->isArray()) {
        return values;
    }
    for (const auto &item : field->array_value) {
        if (item.isString()) {
            values.push_back(item.string_value);
        }
    }
    return values;
}

int parseNumberString(const std::string &value)
{
    std::size_t index = 0;
    const auto number = std::stod(value, &index);
    while (index < value.size() && std::isspace(static_cast<unsigned char>(value[index])) != 0) {
        ++index;
    }
    if (index != value.size()) {
        throw std::runtime_error("invalid numeric value");
    }
    return static_cast<int>(number);
}

std::vector<int> parsePosition(const std::string &value)
{
    std::vector<int> result;
    std::stringstream stream(value);
    std::string part;
    while (std::getline(stream, part, ',')) {
        result.push_back(parseNumberString(part));
    }
    if (result.size() != 3) {
        throw std::runtime_error("position must contain x, y, z");
    }
    return result;
}

std::string claimId(const std::string &owner, const std::string &name, const std::string &dimension)
{
    return owner + ":" + name + ":" + dimension;
}

std::optional<LandClaim> parseClaim(const std::string &owner, const std::string &name, const JsonValue &config,
                                    std::string_view world, std::int64_t updated_at_ms)
{
    if (!config.isObject()) {
        return std::nullopt;
    }

    const auto posa = parsePosition(stringField(config, "posa"));
    const auto posb = parsePosition(stringField(config, "posb"));
    const auto dimension = stringField(config, "dim");
    if (dimension.empty()) {
        return std::nullopt;
    }

    LandClaim claim;
    claim.owner = owner;
    claim.name = name;
    claim.world = std::string(world);
    claim.dimension = dimension;
    claim.id = claimId(owner, name, dimension);
    claim.min_x = std::min(posa[0], posb[0]);
    claim.max_x = std::max(posa[0], posb[0]);
    claim.min_y = std::min(posa[1], posb[1]);
    claim.max_y = std::max(posa[1], posb[1]);
    claim.min_z = std::min(posa[2], posb[2]);
    claim.max_z = std::max(posa[2], posb[2]);
    claim.teleport = {
        parseNumberString(stringField(config, "tpposx")),
        parseNumberString(stringField(config, "tpposy")),
        parseNumberString(stringField(config, "tpposz")),
    };
    claim.members = stringArrayField(config, "member");
    claim.parent = stringField(config, "father");
    claim.children = stringArrayField(config, "son");
    claim.nested = boolField(config, "in") || !claim.parent.empty();
    claim.public_teleport = boolField(config, "tppublic");
    claim.updated_at_ms = updated_at_ms;
    return claim;
}

}  // namespace

LandParseResult parseLandConfig(std::string_view source, std::string_view world, std::int64_t updated_at_ms)
{
    LandParseResult result;
    const auto root = JsonParser(source).parse();
    if (!root.isObject()) {
        return result;
    }

    for (const auto &[owner, entries] : root.object_value) {
        if (!entries.isArray()) {
            ++result.skipped_entries;
            continue;
        }
        for (const auto &entry : entries.array_value) {
            if (!entry.isObject()) {
                ++result.skipped_entries;
                continue;
            }
            for (const auto &[name, config] : entry.object_value) {
                try {
                    if (auto claim = parseClaim(owner, name, config, world, updated_at_ms)) {
                        result.claims.push_back(std::move(*claim));
                    }
                    else {
                        ++result.skipped_entries;
                    }
                }
                catch (...) {
                    ++result.skipped_entries;
                }
            }
        }
    }
    return result;
}

LandParseResult loadLandConfig(const std::filesystem::path &path, std::string_view world, std::int64_t updated_at_ms)
{
    std::ifstream in(path);
    if (!in) {
        return {};
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return parseLandConfig(buffer.str(), world, updated_at_ms);
}

std::string serializeLandBatch(const std::vector<LandClaim> &claims)
{
    std::ostringstream out;
    out << "{\"claims\":[";
    for (std::size_t i = 0; i < claims.size(); ++i) {
        const auto &claim = claims[i];
        if (i != 0) {
            out << ',';
        }
        out << "{\"id\":\"" << jsonEscape(claim.id) << "\",\"owner\":\"" << jsonEscape(claim.owner)
            << "\",\"name\":\"" << jsonEscape(claim.name) << "\",\"world\":\"" << jsonEscape(claim.world)
            << "\",\"dimension\":\"" << jsonEscape(claim.dimension) << "\",\"minX\":" << claim.min_x
            << ",\"maxX\":" << claim.max_x << ",\"minY\":" << claim.min_y << ",\"maxY\":" << claim.max_y
            << ",\"minZ\":" << claim.min_z << ",\"maxZ\":" << claim.max_z << ",\"teleport\":{\"x\":"
            << claim.teleport.x << ",\"y\":" << claim.teleport.y << ",\"z\":" << claim.teleport.z
            << "},\"members\":[";
        for (std::size_t member_index = 0; member_index < claim.members.size(); ++member_index) {
            if (member_index != 0) {
                out << ',';
            }
            out << '"' << jsonEscape(claim.members[member_index]) << '"';
        }
        out << "],\"parent\":\"" << jsonEscape(claim.parent) << "\",\"children\":[";
        for (std::size_t child_index = 0; child_index < claim.children.size(); ++child_index) {
            if (child_index != 0) {
                out << ',';
            }
            out << '"' << jsonEscape(claim.children[child_index]) << '"';
        }
        out << "],\"nested\":" << (claim.nested ? "true" : "false")
            << ",\"publicTeleport\":" << (claim.public_teleport ? "true" : "false")
            << ",\"updatedAt\":" << claim.updated_at_ms << '}';
    }
    out << "]}";
    return out.str();
}

}  // namespace livemap
