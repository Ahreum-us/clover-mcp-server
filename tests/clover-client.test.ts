import axios from "axios";
import { CloverClient } from "../src/clover-client.js";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockHttp = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  defaults: { headers: {} },
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
};

mockedAxios.create.mockReturnValue(mockHttp as any);

const config = { accessToken: "test-token", merchantId: "MERCHANT1" };

describe("CloverClient", () => {
  let client: CloverClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.create.mockReturnValue(mockHttp as any);
    client = new CloverClient(config);
  });

  test("v3() builds correct merchant path", () => {
    expect(client.v3("/orders")).toBe("/v3/merchants/MERCHANT1/orders");
  });

  test("get() returns response data", async () => {
    mockHttp.get.mockResolvedValue({ data: { elements: [{ id: "ord1" }] } });
    const result = await client.get("/v3/merchants/MERCHANT1/orders");
    expect(result).toEqual({ elements: [{ id: "ord1" }] });
  });

  test("post() returns response data", async () => {
    mockHttp.post.mockResolvedValue({ data: { id: "cust1", firstName: "Kim" } });
    const result = await client.post("/v3/merchants/MERCHANT1/customers", { firstName: "Kim" });
    expect(result).toEqual({ id: "cust1", firstName: "Kim" });
  });

  test("sandbox flag points to sandbox base URL", () => {
    new CloverClient({ ...config, sandbox: true });
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://apisandbox.dev.clover.com" })
    );
  });

  test("production flag points to production base URL", () => {
    new CloverClient({ ...config, sandbox: false });
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.clover.com" })
    );
  });
});
