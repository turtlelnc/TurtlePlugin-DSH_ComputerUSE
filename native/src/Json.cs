// TurtlePlugin-DSH_ComputerUSE — native driver
// Minimal JSON layer built on .NET Framework's JavaScriptSerializer.
// Requests are NDJSON on stdin, responses are NDJSON on stdout.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Web.Script.Serialization;

namespace TurtleComputerUse
{
    /// <summary>JSON helpers shared by the RPC loop and every action handler.</summary>
    internal static class Json
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue,
            RecursionLimit = 512,
        };

        public static Dictionary<string, object> NewObject()
        {
            return new Dictionary<string, object>(StringComparer.Ordinal);
        }

        public static Dictionary<string, object> ParseObject(string text)
        {
            var value = Serializer.DeserializeObject(text) as Dictionary<string, object>;
            if (value == null) throw new ProtocolException("invalid_request", "Request must be a JSON object");
            return value;
        }

        public static string Write(object value)
        {
            return Serializer.Serialize(value);
        }

        /// <summary>Read a member, or null.</summary>
        public static object Get(IDictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value)) return null;
            return value;
        }

        public static string GetString(IDictionary<string, object> source, string key, string fallback = null)
        {
            var v = Get(source, key);
            if (v == null) return fallback;
            var s = v as string;
            if (s != null) return s;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        public static bool GetBool(IDictionary<string, object> source, string key, bool fallback = false)
        {
            var v = Get(source, key);
            if (v == null) return fallback;
            if (v is bool) return (bool)v;
            var s = v as string;
            if (s != null) return s.Equals("true", StringComparison.OrdinalIgnoreCase) || s == "1";
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture) != 0; }
            catch { return fallback; }
        }

        public static double GetDouble(IDictionary<string, object> source, string key, double fallback = 0)
        {
            var v = Get(source, key);
            if (v == null) return fallback;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        public static int GetInt(IDictionary<string, object> source, string key, int fallback = 0)
        {
            var v = Get(source, key);
            if (v == null) return fallback;
            try { return Convert.ToInt32(Convert.ToDouble(v, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        public static IntPtr GetHandle(IDictionary<string, object> source, string key)
        {
            var v = Get(source, key);
            if (v == null) return IntPtr.Zero;
            var text = v as string;
            if (text != null)
            {
                long parsed;
                if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return new IntPtr(parsed);
                return IntPtr.Zero;
            }
            try { return new IntPtr(Convert.ToInt64(v, CultureInfo.InvariantCulture)); }
            catch { return IntPtr.Zero; }
        }

        /// <summary>Build an object from alternating key/value arguments (C# 5 has no collection initializer on a call).</summary>
        public static Dictionary<string, object> Obj(params object[] pairs)
        {
            var o = NewObject();
            for (int i = 0; i + 1 < pairs.Length; i += 2)
                o[(string)pairs[i]] = pairs[i + 1];
            return o;
        }

        /// <summary>Coerce a JSON value into a list of strings (`["ctrl","s"]`, `"ctrl+s"`, or null).</summary>
        public static List<string> GetStringList(IDictionary<string, object> source, string key)
        {
            var v = Get(source, key);
            var result = new List<string>();
            if (v == null) return result;
            var s = v as string;
            if (s != null)
            {
                foreach (var part in s.Split(new[] { '+', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                    result.Add(part.Trim());
                return result;
            }
            var arr = v as IEnumerable;
            if (arr == null) return result;
            foreach (var item in arr)
            {
                if (item == null) continue;
                var text = item as string ?? Convert.ToString(item, CultureInfo.InvariantCulture);
                if (!string.IsNullOrWhiteSpace(text)) result.Add(text.Trim());
            }
            return result;
        }

        public static List<object> GetList(IDictionary<string, object> source, string key)
        {
            var v = Get(source, key);
            var list = v as IEnumerable;
            var result = new List<object>();
            if (list == null || v is string) return result;
            foreach (var item in list) result.Add(item);
            return result;
        }

        public static Dictionary<string, object> GetObject(IDictionary<string, object> source, string key)
        {
            return Get(source, key) as Dictionary<string, object>;
        }

        /// <summary>Escape a string for embedding in a hand-built JSON fragment.</summary>
        public static string Escape(string value)
        {
            if (value == null) return "";
            var sb = new StringBuilder(value.Length + 8);
            foreach (var c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }

    /// <summary>An error that maps onto the wire error envelope without a stack trace.</summary>
    internal class ProtocolException : Exception
    {
        public string Code { get; private set; }
        public Dictionary<string, object> Detail { get; private set; }

        public ProtocolException(string code, string message, Dictionary<string, object> detail = null)
            : base(message)
        {
            Code = code;
            Detail = detail;
        }
    }
}
